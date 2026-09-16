// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Interface ERC-20 do USDC nativo da Arc.
interface IUSDC {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title MeteredChannel
 * @notice Canal de pagamento medido para serviços consumidos por agentes autônomos.
 *
 * O problema: um agente paga por chamada de API valores como US$0,004. Uma
 * transação on-chain por chamada é economicamente absurda — o gás vira uma
 * fração grande do próprio pagamento, e o agente faz centenas de chamadas.
 *
 * A solução: o pagador deposita uma vez. A cada chamada servida ele assina,
 * fora da cadeia, um comprovante com o **total acumulado** devido. O provedor
 * guarda apenas o comprovante de maior valor e liquida on-chain **uma vez**,
 * quando quiser. Mil chamadas custam uma transação, não mil.
 *
 * Por que o acumulado e não o valor da chamada: comprovantes acumulados são
 * imunes a repetição por construção. Reapresentar um comprovante antigo paga
 * zero, porque o contrato só transfere a diferença contra o que já foi pago.
 * Não há nonce por chamada, não há lista de comprovantes gastos, não há estado
 * que cresça com o uso.
 *
 * --- Por que este contrato pertence à Arc ---
 *
 * Em qualquer outra chain, um provedor pago em USDC não consegue sacar sem ter
 * o token nativo da rede. Ele pode ter recebido e não conseguir pegar: o ativo
 * que ele ganhou e o ativo que ele precisa gastar para pegar são diferentes.
 *
 * Na Arc, USDC é o gás. O custo de liquidar é cotado no mesmo ativo que está
 * sendo liquidado, então "já vale a pena sacar?" é uma comparação única, em uma
 * unidade só — e quem ganhou qualquer coisa sempre consegue pagar para receber.
 * Isso é o que torna serviço medido viável sem custódia.
 */
contract MeteredChannel {
    IUSDC public constant USDC = IUSDC(0x3600000000000000000000000000000000000000);

    struct Channel {
        address payer;      // quem deposita e assina os comprovantes
        address provider;   // quem serve as chamadas e resgata
        uint256 deposited;  // total depositado no canal
        uint256 claimed;    // total já resgatado pelo provedor
        uint64  expiry;     // a partir daqui o pagador recupera o resto
        bool    open;
    }

    /// @dev EIP-712. Inclui chainId, então comprovante de testnet não vale em mainnet.
    bytes32 public immutable DOMAIN_SEPARATOR;
    bytes32 private constant VOUCHER_TYPEHASH =
        keccak256("Voucher(bytes32 channelId,uint256 cumulative)");

    mapping(bytes32 => Channel) public channels;
    mapping(address => uint256) public nonces;

    event ChannelOpened(
        bytes32 indexed id, address indexed payer, address indexed provider,
        uint256 amount, uint64 expiry
    );
    event ChannelToppedUp(bytes32 indexed id, uint256 amount, uint256 deposited);
    event Claimed(bytes32 indexed id, address indexed provider, uint256 paid, uint256 cumulative);
    event ChannelClosed(bytes32 indexed id, uint256 refunded);

    error ZeroAddress();
    error ZeroAmount();
    error SelfChannel();
    error BadDuration();
    error UnknownChannel();
    error ChannelClosedError();
    error NotPayer();
    error NotProvider();
    error Expired();
    error NotYetExpired();
    error CumulativeNotIncreasing(uint256 cumulative, uint256 claimed);
    error ExceedsDeposit(uint256 cumulative, uint256 deposited);
    error BadSignature();
    error TransferFailed();

    constructor() {
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("MeteredChannel"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    // --- Pagador ---

    /**
     * @notice Abre um canal e deposita. Exige `approve` no USDC antes.
     * @param duration Segundos até o pagador poder recuperar o saldo não resgatado.
     */
    function open(address provider, uint256 amount, uint64 duration)
        external
        returns (bytes32 id)
    {
        if (provider == address(0)) revert ZeroAddress();
        if (provider == msg.sender) revert SelfChannel();
        if (amount == 0) revert ZeroAmount();
        // Prazo mínimo protege o provedor: sem ele o pagador abriria canais que
        // expiram no bloco seguinte e retomaria os fundos antes de qualquer saque.
        if (duration < 1 hours) revert BadDuration();

        id = keccak256(abi.encode(msg.sender, provider, nonces[msg.sender]++, block.chainid));
        uint64 expiry = uint64(block.timestamp) + duration;

        channels[id] = Channel({
            payer: msg.sender, provider: provider,
            deposited: amount, claimed: 0, expiry: expiry, open: true
        });

        if (!USDC.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        emit ChannelOpened(id, msg.sender, provider, amount, expiry);
    }

    /// @notice Recarrega um canal aberto. Não altera o prazo.
    function topUp(bytes32 id, uint256 amount) external {
        Channel storage c = channels[id];
        if (c.payer == address(0)) revert UnknownChannel();
        if (!c.open) revert ChannelClosedError();
        if (msg.sender != c.payer) revert NotPayer();
        if (amount == 0) revert ZeroAmount();
        if (block.timestamp >= c.expiry) revert Expired();

        c.deposited += amount;
        if (!USDC.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        emit ChannelToppedUp(id, amount, c.deposited);
    }

    /// @notice Depois do prazo, o pagador recupera o que não foi resgatado.
    function close(bytes32 id) external {
        Channel storage c = channels[id];
        if (c.payer == address(0)) revert UnknownChannel();
        if (!c.open) revert ChannelClosedError();
        if (msg.sender != c.payer) revert NotPayer();
        if (block.timestamp < c.expiry) revert NotYetExpired();

        uint256 refund = c.deposited - c.claimed;
        c.open = false;
        if (refund > 0 && !USDC.transfer(c.payer, refund)) revert TransferFailed();
        emit ChannelClosed(id, refund);
    }

    // --- Provedor ---

    /**
     * @notice Resgata até `cumulative`, o total acumulado assinado pelo pagador.
     * @dev Paga apenas a diferença contra o que já foi resgatado. Reapresentar um
     *      comprovante antigo reverte em `CumulativeNotIncreasing` em vez de pagar
     *      de novo — é daí que vem a imunidade a repetição.
     */
    function claim(bytes32 id, uint256 cumulative, bytes calldata signature) external {
        Channel storage c = channels[id];
        if (c.payer == address(0)) revert UnknownChannel();
        if (!c.open) revert ChannelClosedError();
        if (msg.sender != c.provider) revert NotProvider();
        if (block.timestamp >= c.expiry) revert Expired();
        if (cumulative <= c.claimed) revert CumulativeNotIncreasing(cumulative, c.claimed);
        if (cumulative > c.deposited) revert ExceedsDeposit(cumulative, c.deposited);

        if (_recover(id, cumulative, signature) != c.payer) revert BadSignature();

        uint256 paid = cumulative - c.claimed;
        c.claimed = cumulative;              // efeito antes da interação

        if (!USDC.transfer(c.provider, paid)) revert TransferFailed();
        emit Claimed(id, c.provider, paid, cumulative);
    }

    // --- Leitura ---

    function digest(bytes32 id, uint256 cumulative) public view returns (bytes32) {
        return keccak256(abi.encodePacked(
            "\x19\x01", DOMAIN_SEPARATOR,
            keccak256(abi.encode(VOUCHER_TYPEHASH, id, cumulative))
        ));
    }

    /// @notice Quanto o provedor ainda pode resgatar neste canal.
    function claimable(bytes32 id) external view returns (uint256) {
        Channel storage c = channels[id];
        return c.open ? c.deposited - c.claimed : 0;
    }

    /**
     * @notice Valor acumulado mínimo a partir do qual vale a pena liquidar.
     * @dev Só é uma pergunta respondível porque na Arc o gás é cotado no mesmo
     *      ativo do pagamento. Em outra chain o resultado sairia em ETH e a
     *      comparação exigiria um oráculo de preço.
     * @param gasPrice Preço de gás em wei (18 decimais, como o saldo nativo).
     * @return Mínimo em unidades da interface ERC-20 do USDC (6 decimais).
     */
    function breakevenClaim(uint256 gasPrice) external pure returns (uint256) {
        uint256 costWei = 75_000 * gasPrice;   // custo observado de um claim
        return costWei / 1e12;                 // 18 decimais -> 6 decimais
    }

    function _recover(bytes32 id, uint256 cumulative, bytes calldata sig)
        private view returns (address)
    {
        if (sig.length != 65) revert BadSignature();
        bytes32 r; bytes32 s; uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        // Rejeita a metade alta de s: sem isso toda assinatura tem uma gêmea válida.
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            revert BadSignature();
        }
        if (v != 27 && v != 28) revert BadSignature();
        address signer = ecrecover(digest(id, cumulative), v, r, s);
        if (signer == address(0)) revert BadSignature();
        return signer;
    }
}
