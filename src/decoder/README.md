# 🔬 XDR & ScVal Event Decoder (`src/decoder/`)

## Architecture & Responsibilities
- Soroban events arrive from RPC as base64-encoded Stellar XDR (External Data Representation).
- The decoder translates these low-level binary formats into standard, strongly-typed JavaScript domain models (`DecodedSorobanEvent`).

## Decoding Rules & Safety
1. **No Floating-Point Math**:
   - Soroban balances and transfer amounts are unsigned/signed 128-bit integers (`i128` / `u128`).
   - JavaScript `Number` loses precision above $2^{53} - 1$ (9,007,199,254,740,991).
   - All amounts **MUST** be decoded into native `BigInt` or string representations.
2. **Address Normalization**:
   - Decodes `ScValType.scvAddress` into valid StrKey strings:
     - `C...` for Contract addresses
     - `G...` for Account public keys
3. **Symbol Extraction**:
   - Converts `scvSymbol` into UTF-8 strings (e.g., `"transfer"`, `"mint"`, `"pause"`, `"emergency_stop"`).
4. **Resilient Parsing**:
   - If an unknown or custom contract emits unconventional XDR structures, the decoder safely parses what it can, serializes custom structures to JSON, and preserves the raw XDR string in `rawXdr` for forensic replay.
