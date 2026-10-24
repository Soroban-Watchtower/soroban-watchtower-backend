import {
  xdr,
  scValToNative,
  Address,
  StrKey,
  ScInt,
} from '@stellar/stellar-sdk';
import { DecodedSorobanEvent } from '../types/index.js';

/**
 * Raw Soroban event as received from Soroban RPC getEvents method.
 */
export interface RawSorobanRpcEvent {
  id?: string;
  contractId?: string;
  type?: 'contract' | 'system' | 'diagnostic' | string;
  ledger?: number | string | bigint;
  ledgerClosedAt?: string | Date;
  txHash?: string;
  pagingToken?: string;
  inSuccessfulContractCall?: boolean;
  topic: (string | xdr.ScVal)[];
  value: string | { xdr: string } | xdr.ScVal;
  rawXdr?: string;
}

/**
 * Optional metadata for decoded events when parsing standalone XDR fixtures.
 */
export interface EventMetadata {
  id?: string;
  ledger?: number | string | bigint;
  ledgerClosedAt?: string | Date;
  txHash?: string;
  contractId?: string;
  type?: 'contract' | 'system' | 'diagnostic';
}

/**
 * Parsed SAC (Stellar Asset Contract / SEP-41) token event structure.
 */
export interface SacEventPayload {
  action: 'transfer' | 'mint' | 'clawback' | 'burn' | string;
  from?: string;
  to?: string;
  admin?: string;
  amount?: bigint;
}

/**
 * Safely parses an ScVal into a native JavaScript representation.
 * - 128-bit and 64-bit integers (i128, u128, i64, u64) are decoded into native JavaScript BigInt
 * - Addresses (scvAddress) are normalized to StrKey strings ('C...' or 'G...')
 * - Symbols (scvSymbol) and strings (scvString) are decoded to UTF-8 strings
 * - Maps (scvMap) are converted into JavaScript plain objects
 * - Vectors (scvVec) are converted into JavaScript arrays
 * - Void (scvVoid) is converted to null
 * - Resilient: invalid/unparseable XDR falls back without throwing unhandled exceptions.
 *
 * @param scValInput Raw base64 XDR string or xdr.ScVal instance
 * @returns Clean native JavaScript value
 */
export function decodeScVal(scValInput: string | xdr.ScVal): any {
  if (scValInput === undefined || scValInput === null) {
    return null;
  }

  let parsedScVal: xdr.ScVal;

  if (typeof scValInput === 'string') {
    try {
      parsedScVal = xdr.ScVal.fromXDR(scValInput, 'base64');
    } catch (err: any) {
      // Resilient fallback for non-XDR or corrupted strings
      return {
        _unparsed: true,
        raw: scValInput,
        error: err?.message ?? 'Failed to parse ScVal XDR',
      };
    }
  } else {
    parsedScVal = scValInput;
  }

  try {
    const scValType = parsedScVal.switch().value;

    // Explicitly handle 128-bit signed/unsigned integers to guarantee BigInt
    if (
      scValType === xdr.ScValType.scvI128().value ||
      scValType === xdr.ScValType.scvU128().value
    ) {
      const parts = parsedScVal.value();
      if (scValType === xdr.ScValType.scvU128().value) {
        const uParts = parts as xdr.UInt128Parts;
        const hi = BigInt(uParts.hi().toString());
        const lo = BigInt(uParts.lo().toString());
        return (hi << 64n) + lo;
      } else {
        const iParts = parts as xdr.Int128Parts;
        const hi = BigInt(iParts.hi().toString());
        const lo = BigInt(iParts.lo().toString());
        return (hi << 64n) + lo;
      }
    }

    // Explicitly handle 256-bit signed/unsigned integers
    if (
      scValType === xdr.ScValType.scvI256().value ||
      scValType === xdr.ScValType.scvU256().value
    ) {
      const parts = parsedScVal.value();
      const hiHi = BigInt((parts as any).hiHi().toString());
      const hiLo = BigInt((parts as any).hiLo().toString());
      const loHi = BigInt((parts as any).loHi().toString());
      const loLo = BigInt((parts as any).loLo().toString());
      return (hiHi << 192n) + (hiLo << 128n) + (loHi << 64n) + loLo;
    }

    // Explicitly handle 64-bit integers to guarantee BigInt
    if (scValType === xdr.ScValType.scvU64().value) {
      return BigInt((parsedScVal.u64() as any).toString());
    }
    if (scValType === xdr.ScValType.scvI64().value) {
      return BigInt((parsedScVal.i64() as any).toString());
    }
    if (scValType === xdr.ScValType.scvTimepoint().value) {
      return BigInt((parsedScVal.timepoint() as any).toString());
    }
    if (scValType === xdr.ScValType.scvDuration().value) {
      return BigInt((parsedScVal.duration() as any).toString());
    }

    // Address normalization (Contract 'C...' or Account 'G...')
    if (scValType === xdr.ScValType.scvAddress().value) {
      return Address.fromScVal(parsedScVal).toString();
    }

    // Symbols & Strings
    if (
      scValType === xdr.ScValType.scvSymbol().value ||
      scValType === xdr.ScValType.scvString().value
    ) {
      const rawVal = parsedScVal.value();
      if (Buffer.isBuffer(rawVal) || ArrayBuffer.isView(rawVal)) {
        return Buffer.from(rawVal as any).toString('utf8');
      }
      return String(rawVal);
    }

    // Vectors
    if (scValType === xdr.ScValType.scvVec().value) {
      const vec = parsedScVal.vec() ?? [];
      return vec.map((item) => decodeScVal(item));
    }

    // Maps
    if (scValType === xdr.ScValType.scvMap().value) {
      const mapEntries = parsedScVal.map() ?? [];
      const result: Record<string, any> = {};
      for (const entry of mapEntries) {
        const key = String(decodeScVal(entry.key()));
        result[key] = decodeScVal(entry.val());
      }
      return result;
    }

    // Default stellar-sdk native converter for primitives (bool, void, bytes, u32, i32)
    const native = scValToNative(parsedScVal);
    if (Buffer.isBuffer(native) || native instanceof Uint8Array) {
      return Buffer.from(native).toString('hex');
    }
    return native;
  } catch (err: any) {
    return {
      _unparsed: true,
      error: err?.message ?? 'Failed to decode ScVal',
    };
  }
}

/**
 * Normalizes a decoded topic item into a valid string, number, or bigint.
 * Ensures the resulting topics array strictly adheres to `(string | number | bigint)[]`.
 *
 * @param rawTopic Raw base64 XDR string or xdr.ScVal
 */
export function decodeTopic(rawTopic: string | xdr.ScVal): string | number | bigint {
  const decoded = decodeScVal(rawTopic);

  if (typeof decoded === 'string' || typeof decoded === 'number' || typeof decoded === 'bigint') {
    return decoded;
  }

  if (Buffer.isBuffer(decoded) || decoded instanceof Uint8Array) {
    return Buffer.from(decoded).toString('hex');
  }

  if (decoded === null || decoded === undefined) {
    return '';
  }

  return JSON.stringify(decoded);
}

/**
 * Normalizes event type to 'contract' | 'system' | 'diagnostic'.
 */
function normalizeEventType(type?: string): 'contract' | 'system' | 'diagnostic' {
  if (!type) return 'contract';
  const lower = type.toLowerCase();
  if (lower.includes('system')) return 'system';
  if (lower.includes('diagnostic')) return 'diagnostic';
  return 'contract';
}

/**
 * Pure function that takes raw base64 XDR events from Stellar or Soroban RPC payloads
 * and converts them into clean, strongly-typed JavaScript domain models (`DecodedSorobanEvent`).
 *
 * Supports:
 * 1. Soroban RPC `RawSorobanRpcEvent` objects (where topics & value are base64 XDR)
 * 2. Raw base64 strings of `xdr.ContractEvent`
 * 3. Raw base64 strings of `xdr.DiagnosticEvent`
 * 4. JSON-stringified RPC event objects
 *
 * @param input Raw event object or base64 XDR string
 * @param metadata Optional metadata to populate ledger/txHash if parsing raw XDR string
 * @returns Fully decoded `DecodedSorobanEvent`
 */
export function decodeSorobanEvent(
  input: RawSorobanRpcEvent | string | xdr.ContractEvent | xdr.DiagnosticEvent,
  metadata?: EventMetadata
): DecodedSorobanEvent {
  // Case 1: Input is a string (could be JSON or base64 XDR)
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const parsedJson = JSON.parse(trimmed) as RawSorobanRpcEvent;
        return decodeSorobanEvent(parsedJson, metadata);
      } catch {
        // Not valid JSON, continue to XDR parsing
      }
    }

    // Try parsing as DiagnosticEvent
    try {
      const diag = xdr.DiagnosticEvent.fromXDR(trimmed, 'base64');
      return decodeDiagnosticEvent(diag, trimmed, metadata);
    } catch {
      // Not a DiagnosticEvent, continue to ContractEvent
    }

    // Try parsing as ContractEvent
    try {
      const contractEvt = xdr.ContractEvent.fromXDR(trimmed, 'base64');
      return decodeContractEvent(contractEvt, trimmed, metadata);
    } catch {
      // If neither parses directly, fallback to resilient model
      return {
        id: metadata?.id ?? 'unknown',
        contractId: metadata?.contractId ?? '',
        type: metadata?.type ?? 'contract',
        ledger: BigInt(metadata?.ledger ?? 0),
        ledgerClosedAt: metadata?.ledgerClosedAt ? new Date(metadata.ledgerClosedAt) : new Date(),
        txHash: metadata?.txHash ?? '',
        topics: [],
        data: { _unparsed: true, raw: trimmed, error: 'Unrecognized XDR format' },
        rawXdr: trimmed,
      };
    }
  }

  // Case 2: Input is an instance of xdr.DiagnosticEvent
  if (input instanceof xdr.DiagnosticEvent) {
    return decodeDiagnosticEvent(input, input.toXDR('base64'), metadata);
  }

  // Case 3: Input is an instance of xdr.ContractEvent
  if (input instanceof xdr.ContractEvent) {
    return decodeContractEvent(input, input.toXDR('base64'), metadata);
  }

  // Case 4: Input is a RawSorobanRpcEvent object
  const rpcEvent = input as RawSorobanRpcEvent;

  // Extract raw XDR string for forensic persistence
  let rawXdrString = rpcEvent.rawXdr ?? '';
  if (!rawXdrString) {
    if (typeof rpcEvent.value === 'string') {
      rawXdrString = rpcEvent.value;
    } else if (rpcEvent.value && typeof rpcEvent.value === 'object' && 'xdr' in rpcEvent.value) {
      rawXdrString = (rpcEvent.value as any).xdr;
    } else if (rpcEvent.value instanceof xdr.ScVal) {
      rawXdrString = rpcEvent.value.toXDR('base64');
    } else {
      rawXdrString = JSON.stringify({
        topic: rpcEvent.topic,
        value: rpcEvent.value,
      });
    }
  }

  const rawTopics = Array.isArray(rpcEvent.topic) ? rpcEvent.topic : [];
  const decodedTopics = rawTopics.map((topicItem) => decodeTopic(topicItem));

  let valueInput = rpcEvent.value;
  if (valueInput && typeof valueInput === 'object' && 'xdr' in valueInput) {
    valueInput = (valueInput as any).xdr;
  }
  const decodedData = decodeScVal(valueInput as string | xdr.ScVal);

  const ledger = BigInt(rpcEvent.ledger ?? metadata?.ledger ?? 0);
  const ledgerClosedAt = rpcEvent.ledgerClosedAt
    ? new Date(rpcEvent.ledgerClosedAt)
    : metadata?.ledgerClosedAt
    ? new Date(metadata.ledgerClosedAt)
    : new Date();

  return {
    id: rpcEvent.id ?? metadata?.id ?? `${ledger}-0-0`,
    contractId: rpcEvent.contractId ?? metadata?.contractId ?? '',
    type: normalizeEventType(rpcEvent.type ?? metadata?.type),
    ledger,
    ledgerClosedAt,
    txHash: rpcEvent.txHash ?? metadata?.txHash ?? '',
    topics: decodedTopics,
    data: decodedData,
    rawXdr: rawXdrString,
  };
}

/**
 * Decodes an xdr.ContractEvent into a DecodedSorobanEvent.
 */
function decodeContractEvent(
  evt: xdr.ContractEvent,
  rawXdr: string,
  metadata?: EventMetadata
): DecodedSorobanEvent {
  let contractId = metadata?.contractId ?? '';
  try {
    const rawContractId = evt.contractId();
    if (rawContractId) {
      contractId = StrKey.encodeContract(rawContractId);
    }
  } catch {
    // contractId is optional in some system events
  }

  const eventType = normalizeEventType(evt.type().name);
  const body = evt.body().value();
  const topics = (body.topics() ?? []).map((t) => decodeTopic(t));
  const data = decodeScVal(body.data());

  const ledger = BigInt(metadata?.ledger ?? 0);
  const ledgerClosedAt = metadata?.ledgerClosedAt
    ? new Date(metadata.ledgerClosedAt)
    : new Date();

  return {
    id: metadata?.id ?? `${ledger}-0-0`,
    contractId,
    type: eventType,
    ledger,
    ledgerClosedAt,
    txHash: metadata?.txHash ?? '',
    topics,
    data,
    rawXdr,
  };
}

/**
 * Decodes an xdr.DiagnosticEvent into a DecodedSorobanEvent.
 */
function decodeDiagnosticEvent(
  diag: xdr.DiagnosticEvent,
  rawXdr: string,
  metadata?: EventMetadata
): DecodedSorobanEvent {
  const innerEvt = diag.event();
  const decoded = decodeContractEvent(innerEvt, rawXdr, metadata);
  return {
    ...decoded,
    type: 'diagnostic',
  };
}

/**
 * Convenient alias for decodeSorobanEvent.
 */
export const decodeEvent = decodeSorobanEvent;

/**
 * Helper to inspect and extract structured SAC (Stellar Asset Contract) token events (SEP-41).
 * Detects 'transfer', 'mint', 'clawback', and 'burn' events and returns clean domain fields.
 *
 * @param event Decoded Soroban Event
 * @returns SacEventPayload or null if not a recognized SAC event
 */
export function parseSacEvent(event: DecodedSorobanEvent): SacEventPayload | null {
  if (!event.topics || event.topics.length === 0) {
    return null;
  }

  const action = String(event.topics[0]);

  switch (action) {
    case 'transfer': {
      // Topics: ['transfer', from: Address, to: Address]
      // Data: amount (i128)
      const from = event.topics[1] ? String(event.topics[1]) : undefined;
      const to = event.topics[2] ? String(event.topics[2]) : undefined;
      const amount = typeof event.data === 'bigint' ? event.data : BigInt(event.data ?? 0);
      return { action: 'transfer', from, to, amount };
    }
    case 'mint': {
      // Topics: ['mint', admin: Address, to: Address]
      // Data: amount (i128)
      const admin = event.topics[1] ? String(event.topics[1]) : undefined;
      const to = event.topics[2] ? String(event.topics[2]) : undefined;
      const amount = typeof event.data === 'bigint' ? event.data : BigInt(event.data ?? 0);
      return { action: 'mint', admin, to, amount };
    }
    case 'clawback': {
      // Topics: ['clawback', admin: Address, from: Address]
      // Data: amount (i128)
      const admin = event.topics[1] ? String(event.topics[1]) : undefined;
      const from = event.topics[2] ? String(event.topics[2]) : undefined;
      const amount = typeof event.data === 'bigint' ? event.data : BigInt(event.data ?? 0);
      return { action: 'clawback', admin, from, amount };
    }
    case 'burn': {
      // Topics: ['burn', from: Address]
      // Data: amount (i128)
      const from = event.topics[1] ? String(event.topics[1]) : undefined;
      const amount = typeof event.data === 'bigint' ? event.data : BigInt(event.data ?? 0);
      return { action: 'burn', from, amount };
    }
    default:
      return null;
  }
}
