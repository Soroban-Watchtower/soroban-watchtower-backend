# 📣 Notifier Plugin Subsystem (`src/notifiers/`)

## Architecture & Responsibilities
- Receives queued alert jobs from BullMQ and delivers them to external communication channels.
- Modular, pluggable architecture implementing the `NotifierPlugin` interface.

## Pluggable Interface
```typescript
export interface NotifierPlugin {
  readonly type: ChannelType; // 'DISCORD' | 'TELEGRAM' | 'WEBHOOK'
  send(payload: AlertPayload, destination: string, secret?: string): Promise<DeliveryResult>;
}
```

## Security & Reliability Requirements
1. **SSRF (Server-Side Request Forgery) Protection**:
   - Custom webhooks must be protected against SSRF.
   - Before executing an outgoing HTTP POST, the notifier validates the target URL:
     - Must use `https://` protocol.
     - Performs a DNS resolution and rejects any IP belonging to private/loopback subnets:
       - `127.0.0.0/8` (Localhost)
       - `10.0.0.0/8` (Private Class A)
       - `172.16.0.0/12` (Private Class B)
       - `192.168.0.0/16` (Private Class C)
       - `169.254.0.0/16` (Link-local / Cloud metadata endpoint)
2. **HMAC Webhook Signatures**:
   - Outgoing custom webhooks include an `X-Watchdog-Signature` header computed as:
     ```typescript
     crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
     ```
   - Allows protocol recipients to cryptographically verify the alert originates from Soroban Watchdog.
3. **Secret Encryption**:
   - Webhook destinations and Telegram bot tokens stored in PostgreSQL are encrypted using AES-256-GCM.
   - They are decrypted in memory only when the notifier job executes.
