import { describe, it, expect } from 'vitest';
import {
  xdr,
  Address,
  StrKey,
} from '@stellar/stellar-sdk';
import {
  decodeSorobanEvent,
  decodeEvent,
  decodeScVal,
  decodeTopic,
  parseSacEvent,
  RawSorobanRpcEvent,
} from '../../src/decoder/eventDecoder.js';

describe('Soroban XDR Event Decoder (src/decoder/eventDecoder)', () => {
  // Deterministic 32-byte keys for generating realistic Testnet addresses
  const contractHash = Buffer.from('11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff', 'hex');
  const contractAddressStr = StrKey.encodeContract(contractHash); // Starts with 'C...'

  const accountPublicKey = Buffer.from('99887766554433221100ffeeddccbbaa99887766554433221100ffeeddccbbaa', 'hex');
  const accountAddressStr = StrKey.encodeEd25519PublicKey(accountPublicKey); // Starts with 'G...'

  const recipientPublicKey = Buffer.from('aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899', 'hex');
  const recipientAddressStr = StrKey.encodeEd25519PublicKey(recipientPublicKey); // Starts with 'G...'

  describe('1. ScVal Primitive & Address Decoding', () => {
    it('should correctly decode ScVal symbols into UTF-8 strings', () => {
      const symVal = xdr.ScVal.scvSymbol('emergency_pause');
      const base64Xdr = symVal.toXDR('base64');

      expect(decodeScVal(symVal)).toBe('emergency_pause');
      expect(decodeScVal(base64Xdr)).toBe('emergency_pause');
    });

    it('should correctly normalize Contract addresses to C... StrKey strings', () => {
      const addrScVal = new Address(contractAddressStr).toScVal();
      const base64Xdr = addrScVal.toXDR('base64');

      const decoded = decodeScVal(base64Xdr);
      expect(decoded).toBe(contractAddressStr);
      expect(decoded.startsWith('C')).toBe(true);
    });

    it('should correctly normalize Account addresses to G... StrKey strings', () => {
      const addrScVal = new Address(accountAddressStr).toScVal();
      const base64Xdr = addrScVal.toXDR('base64');

      const decoded = decodeScVal(base64Xdr);
      expect(decoded).toBe(accountAddressStr);
      expect(decoded.startsWith('G')).toBe(true);
    });

    it('should correctly decode scvVoid to null and scvBool to boolean', () => {
      const voidVal = xdr.ScVal.scvVoid();
      expect(decodeScVal(voidVal.toXDR('base64'))).toBeNull();

      const trueVal = xdr.ScVal.scvBool(true);
      expect(decodeScVal(trueVal.toXDR('base64'))).toBe(true);

      const falseVal = xdr.ScVal.scvBool(false);
      expect(decodeScVal(falseVal.toXDR('base64'))).toBe(false);
    });

    it('should decode 32-bit integers into native JavaScript numbers', () => {
      const u32Val = xdr.ScVal.scvU32(4294967);
      expect(decodeScVal(u32Val.toXDR('base64'))).toBe(4294967);

      const i32Val = xdr.ScVal.scvI32(-12345);
      expect(decodeScVal(i32Val.toXDR('base64'))).toBe(-12345);
    });

    it('should decode 64-bit integers and timepoints into native BigInt', () => {
      const u64Val = xdr.ScVal.scvU64(new xdr.Uint64(18446744073709551610n));
      const decodedU64 = decodeScVal(u64Val.toXDR('base64'));
      expect(typeof decodedU64).toBe('bigint');
      expect(decodedU64).toBe(18446744073709551610n);

      const timepointVal = xdr.ScVal.scvTimepoint(new xdr.TimePoint(new xdr.Uint64(1729699200n)));
      const decodedTime = decodeScVal(timepointVal.toXDR('base64'));
      expect(typeof decodedTime).toBe('bigint');
      expect(decodedTime).toBe(1729699200n);
    });
  });

  describe('2. 128-Bit Integer (i128 & u128) Precision & No Floating-Point Bugs', () => {
    it('safely converts large i128 values beyond Number.MAX_SAFE_INTEGER into native BigInt', () => {
      // 100 million tokens with 18 decimals = 100,000,000 * 10^18 = 10^26
      // Far exceeds Number.MAX_SAFE_INTEGER (9,007,199,254,740,991)
      const massiveAmount = 100000000000000000000000000n;
      const hi = massiveAmount >> 64n;
      const lo = massiveAmount & ((1n << 64n) - 1n);

      const i128Val = xdr.ScVal.scvI128(
        new xdr.Int128Parts({
          hi: new xdr.Int64(hi),
          lo: new xdr.Uint64(lo),
        })
      );

      const base64Xdr = i128Val.toXDR('base64');
      const decoded = decodeScVal(base64Xdr);

      expect(typeof decoded).toBe('bigint');
      expect(decoded).toBe(massiveAmount);
      // Verify no precision loss compared to standard BigInt arithmetic
      expect(decoded.toString()).toBe('100000000000000000000000000');
    });

    it('safely decodes max unsigned u128 (2^128 - 1) into native BigInt', () => {
      const maxU128 = (1n << 128n) - 1n; // 340282366920938463463374607431768211455n
      const hi = maxU128 >> 64n;
      const lo = maxU128 & ((1n << 64n) - 1n);

      const u128Val = xdr.ScVal.scvU128(
        new xdr.UInt128Parts({
          hi: new xdr.Uint64(hi),
          lo: new xdr.Uint64(lo),
        })
      );

      const decoded = decodeScVal(u128Val.toXDR('base64'));
      expect(typeof decoded).toBe('bigint');
      expect(decoded).toBe(maxU128);
    });

    it('safely decodes max signed i128 (2^127 - 1) into native BigInt', () => {
      const maxI128 = (1n << 127n) - 1n;
      const hi = maxI128 >> 64n;
      const lo = maxI128 & ((1n << 64n) - 1n);

      const i128Val = xdr.ScVal.scvI128(
        new xdr.Int128Parts({
          hi: new xdr.Int64(hi),
          lo: new xdr.Uint64(lo),
        })
      );

      const decoded = decodeScVal(i128Val.toXDR('base64'));
      expect(typeof decoded).toBe('bigint');
      expect(decoded).toBe(maxI128);
    });
  });

  describe('3. Complex ScVal Structures (Maps & Vectors)', () => {
    it('should decode ScVal maps into JavaScript objects with decoded keys and values', () => {
      const mapVal = xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('admin'),
          val: new Address(accountAddressStr).toScVal(),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('active'),
          val: xdr.ScVal.scvBool(true),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('threshold'),
          val: xdr.ScVal.scvU64(new xdr.Uint64(5000000000n)),
        }),
      ]);

      const decoded = decodeScVal(mapVal.toXDR('base64'));
      expect(decoded).toEqual({
        admin: accountAddressStr,
        active: true,
        threshold: 5000000000n,
      });
      expect(typeof decoded.threshold).toBe('bigint');
    });

    it('should decode ScVal vectors into JavaScript arrays', () => {
      const vecVal = xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol('XLM'),
        xdr.ScVal.scvSymbol('USDC'),
        xdr.ScVal.scvU32(100),
      ]);

      const decoded = decodeScVal(vecVal.toXDR('base64'));
      expect(decoded).toEqual(['XLM', 'USDC', 100]);
    });
  });

  describe('4. Standard SAC (Stellar Asset Contract) Event Decoding', () => {
    it('decodes a real SAC token transfer event from Soroban RPC payload', () => {
      const transferAmount = 15000000000n; // 1,500 USDC (7 decimals)
      const hi = transferAmount >> 64n;
      const lo = transferAmount & ((1n << 64n) - 1n);

      // Construct SAC transfer event:
      // Topic 0: symbol "transfer"
      // Topic 1: from address
      // Topic 2: to address
      // Data: amount (i128)
      const topic0Xdr = xdr.ScVal.scvSymbol('transfer').toXDR('base64');
      const topic1Xdr = new Address(accountAddressStr).toScVal().toXDR('base64');
      const topic2Xdr = new Address(recipientAddressStr).toScVal().toXDR('base64');
      const dataXdr = xdr.ScVal.scvI128(
        new xdr.Int128Parts({
          hi: new xdr.Int64(hi),
          lo: new xdr.Uint64(lo),
        })
      ).toXDR('base64');

      const rawRpcEvent: RawSorobanRpcEvent = {
        id: '0001234567-0000000002-0000000001',
        contractId: contractAddressStr,
        type: 'contract',
        ledger: 1234567,
        ledgerClosedAt: '2026-10-23T12:00:00Z',
        txHash: '3d8a7c2e4f1b5a6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c',
        topic: [topic0Xdr, topic1Xdr, topic2Xdr],
        value: dataXdr,
      };

      const decoded = decodeSorobanEvent(rawRpcEvent);

      expect(decoded.id).toBe('0001234567-0000000002-0000000001');
      expect(decoded.contractId).toBe(contractAddressStr);
      expect(decoded.type).toBe('contract');
      expect(decoded.ledger).toBe(1234567n);
      expect(decoded.ledgerClosedAt).toEqual(new Date('2026-10-23T12:00:00Z'));
      expect(decoded.txHash).toBe('3d8a7c2e4f1b5a6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c');
      expect(decoded.topics).toEqual(['transfer', accountAddressStr, recipientAddressStr]);
      expect(decoded.data).toBe(15000000000n);
      expect(typeof decoded.data).toBe('bigint');

      // Test SAC event parser helper
      const sacParsed = parseSacEvent(decoded);
      expect(sacParsed).toEqual({
        action: 'transfer',
        from: accountAddressStr,
        to: recipientAddressStr,
        amount: 15000000000n,
      });
    });

    it('decodes a SAC mint event and correctly parses SAC fields', () => {
      const mintAmount = 50000000000n;
      const hi = mintAmount >> 64n;
      const lo = mintAmount & ((1n << 64n) - 1n);

      const topic0Xdr = xdr.ScVal.scvSymbol('mint').toXDR('base64');
      const topic1Xdr = new Address(accountAddressStr).toScVal().toXDR('base64'); // admin
      const topic2Xdr = new Address(recipientAddressStr).toScVal().toXDR('base64'); // to
      const dataXdr = xdr.ScVal.scvI128(
        new xdr.Int128Parts({
          hi: new xdr.Int64(hi),
          lo: new xdr.Uint64(lo),
        })
      ).toXDR('base64');

      const rawRpcEvent: RawSorobanRpcEvent = {
        id: '0001234567-0000000003-0000000000',
        contractId: contractAddressStr,
        type: 'contract',
        ledger: 1234567,
        ledgerClosedAt: new Date('2026-10-23T12:05:00Z'),
        txHash: 'aabbccddee1122334455',
        topic: [topic0Xdr, topic1Xdr, topic2Xdr],
        value: dataXdr,
      };

      const decoded = decodeEvent(rawRpcEvent);
      expect(decoded.topics[0]).toBe('mint');
      expect(decoded.data).toBe(50000000000n);

      const sac = parseSacEvent(decoded);
      expect(sac).toEqual({
        action: 'mint',
        admin: accountAddressStr,
        to: recipientAddressStr,
        amount: 50000000000n,
      });
    });

    it('decodes a SAC burn event and correctly parses SAC fields', () => {
      const burnAmount = 1000000000n;
      const hi = burnAmount >> 64n;
      const lo = burnAmount & ((1n << 64n) - 1n);

      const topic0Xdr = xdr.ScVal.scvSymbol('burn').toXDR('base64');
      const topic1Xdr = new Address(accountAddressStr).toScVal().toXDR('base64');
      const dataXdr = xdr.ScVal.scvI128(
        new xdr.Int128Parts({
          hi: new xdr.Int64(hi),
          lo: new xdr.Uint64(lo),
        })
      ).toXDR('base64');

      const rawRpcEvent: RawSorobanRpcEvent = {
        id: '0001234567-0000000004-0000000000',
        contractId: contractAddressStr,
        type: 'contract',
        ledger: 1234567,
        ledgerClosedAt: new Date('2026-10-23T12:10:00Z'),
        txHash: 'eeff0011223344',
        topic: [topic0Xdr, topic1Xdr],
        value: dataXdr,
      };

      const decoded = decodeEvent(rawRpcEvent);
      const sac = parseSacEvent(decoded);
      expect(sac).toEqual({
        action: 'burn',
        from: accountAddressStr,
        amount: 1000000000n,
      });
    });
  });

  describe('5. Raw Stellar XDR ContractEvent & DiagnosticEvent Decoding', () => {
    it('decodes a standalone xdr.ContractEvent from raw base64 XDR string', () => {
      const amount = 2500000000n;
      const hi = amount >> 64n;
      const lo = amount & ((1n << 64n) - 1n);

      const contractEvent = new xdr.ContractEvent({
        ext: new xdr.ExtensionPoint(0),
        contractId: contractHash,
        type: xdr.ContractEventType.contract(),
        body: new xdr.ContractEventBody(0,
          new xdr.ContractEventV0({
            topics: [
              xdr.ScVal.scvSymbol('emergency_pause'),
              new Address(accountAddressStr).toScVal(),
            ],
            data: xdr.ScVal.scvI128(
              new xdr.Int128Parts({
                hi: new xdr.Int64(hi),
                lo: new xdr.Uint64(lo),
              })
            ),
          })
        ),
      });

      const rawBase64 = contractEvent.toXDR('base64');

      const decoded = decodeSorobanEvent(rawBase64, {
        id: '1000-1-0',
        ledger: 1000n,
        txHash: '0x123456',
      });

      expect(decoded.contractId).toBe(contractAddressStr);
      expect(decoded.type).toBe('contract');
      expect(decoded.ledger).toBe(1000n);
      expect(decoded.txHash).toBe('0x123456');
      expect(decoded.topics).toEqual(['emergency_pause', accountAddressStr]);
      expect(decoded.data).toBe(2500000000n);
      expect(decoded.rawXdr).toBe(rawBase64);
    });

    it('decodes an xdr.DiagnosticEvent from raw base64 XDR string', () => {
      const contractEvent = new xdr.ContractEvent({
        ext: new xdr.ExtensionPoint(0),
        contractId: contractHash,
        type: xdr.ContractEventType.contract(),
        body: new xdr.ContractEventBody(0,
          new xdr.ContractEventV0({
            topics: [xdr.ScVal.scvSymbol('fn_call')],
            data: xdr.ScVal.scvSymbol('ok'),
          })
        ),
      });

      const diagEvent = new xdr.DiagnosticEvent({
        inSuccessfulContractCall: true,
        event: contractEvent,
      });

      const rawBase64 = diagEvent.toXDR('base64');

      const decoded = decodeSorobanEvent(rawBase64, {
        ledger: 500n,
      });

      expect(decoded.type).toBe('diagnostic');
      expect(decoded.contractId).toBe(contractAddressStr);
      expect(decoded.topics).toEqual(['fn_call']);
      expect(decoded.data).toBe('ok');
    });

    it('decodes direct xdr.ContractEvent and xdr.DiagnosticEvent object instances', () => {
      const contractEvent = new xdr.ContractEvent({
        ext: new xdr.ExtensionPoint(0),
        contractId: contractHash,
        type: xdr.ContractEventType.system(),
        body: new xdr.ContractEventBody(0,
          new xdr.ContractEventV0({
            topics: [xdr.ScVal.scvSymbol('upgrade')],
            data: xdr.ScVal.scvBool(true),
          })
        ),
      });

      const decoded = decodeSorobanEvent(contractEvent);
      expect(decoded.type).toBe('system');
      expect(decoded.topics).toEqual(['upgrade']);
      expect(decoded.data).toBe(true);
    });
  });

  describe('6. Topic Normalization & Resilient Parsing', () => {
    it('normalizes various topic types to string, number, or bigint', () => {
      expect(decodeTopic(xdr.ScVal.scvSymbol('test'))).toBe('test');
      expect(decodeTopic(xdr.ScVal.scvU32(42))).toBe(42);
      expect(decodeTopic(xdr.ScVal.scvU64(new xdr.Uint64(9999999999n)))).toBe(9999999999n);
      expect(decodeTopic(xdr.ScVal.scvBytes(Buffer.from('hello')))).toBe('68656c6c6f');
    });

    it('handles malformed base64 strings gracefully without throwing', () => {
      const corruptBase64 = 'not-valid-base64-xdr!@#$';

      // decodeScVal should return fallback with unparsed marker
      const decodedScVal = decodeScVal(corruptBase64);
      expect(decodedScVal._unparsed).toBe(true);
      expect(decodedScVal.raw).toBe(corruptBase64);

      // decodeSorobanEvent should return fallback DecodedSorobanEvent
      const decodedEvent = decodeSorobanEvent(corruptBase64, {
        id: 'fallback-id',
        contractId: contractAddressStr,
      });

      expect(decodedEvent.id).toBe('fallback-id');
      expect(decodedEvent.contractId).toBe(contractAddressStr);
      expect(decodedEvent.data._unparsed).toBe(true);
      expect(decodedEvent.rawXdr).toBe(corruptBase64);
    });

    it('parses JSON string representations of RPC events', () => {
      const topic0Xdr = xdr.ScVal.scvSymbol('ping').toXDR('base64');
      const valXdr = xdr.ScVal.scvSymbol('pong').toXDR('base64');

      const jsonString = JSON.stringify({
        id: '1-2-3',
        contractId: contractAddressStr,
        type: 'contract',
        ledger: 100,
        ledgerClosedAt: '2026-10-23T14:00:00Z',
        txHash: '0xabc',
        topic: [topic0Xdr],
        value: valXdr,
      });

      const decoded = decodeSorobanEvent(jsonString);
      expect(decoded.id).toBe('1-2-3');
      expect(decoded.topics).toEqual(['ping']);
      expect(decoded.data).toBe('pong');
    });
  });
});
