import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isPrivateIp,
  isPrivateIpv4,
  isPrivateIpv6,
  validateSsrf,
  assertSsrfSafe,
} from '../../src/notifiers/ssrfValidator.js';
import {
  WebhookNotifier,
  createWebhookNotifier,
  computeWebhookSignature,
  verifyWebhookSignature,
} from '../../src/notifiers/webhook.js';
import {
  DiscordNotifier,
  createDiscordNotifier,
  buildDiscordEmbed,
  buildDiscordPayload,
  isValidDiscordWebhookUrl,
  SEVERITY_COLORS,
  SEVERITY_BADGES,
} from '../../src/notifiers/discord.js';
import {
  TelegramNotifier,
  createTelegramNotifier,
} from '../../src/notifiers/telegram.js';
import { createDefaultNotifierRegistry } from '../../src/notifiers/index.js';
import { AlertWorkerConsumer } from '../../src/queue/alertWorker.js';
import { AlertPayload } from '../../src/types/index.js';

describe('Notification Dispatchers (src/notifiers)', () => {
  const sampleAlert: AlertPayload = {
    alertId: 'alert-stellar-9876',
    contractId: 'CA3D5KRYMCMFZK54DNYNO3TVQAS4PU2QLAXU6VO6JMQG2RCHWHW32VN4',
    ruleId: 'LARGE_VALUE_TRANSFER',
    severity: 'CRITICAL',
    title: 'High-Value Drain Detected',
    message: 'Transfer of 1,000,000 XLM exceeds safe threshold 10,000 XLM',
    timestamp: new Date('2026-10-26T12:00:00.000Z'),
    metadata: {
      amount: '10000000000000',
      threshold: '100000000000',
      assetSymbol: 'XLM',
    },
    explorerUrl: 'https://stellar.expert/explorer/public/contract/CA3D5KRYMCMFZK54DNYNO3TVQAS4PU2QLAXU6VO6JMQG2RCHWHW32VN4',
  };

  // =========================================================================
  // 1. SSRF Protection & IP Validation (src/notifiers/ssrfValidator.ts)
  // =========================================================================
  describe('SSRF Validator (src/notifiers/ssrfValidator)', () => {
    it('should detect private and reserved IPv4 addresses', () => {
      // Loopback
      expect(isPrivateIpv4('127.0.0.1')).toBe(true);
      expect(isPrivateIpv4('127.255.255.255')).toBe(true);
      // Private Class A
      expect(isPrivateIpv4('10.0.0.1')).toBe(true);
      expect(isPrivateIpv4('10.254.1.5')).toBe(true);
      // Private Class B (172.16.0.0 - 172.31.255.255)
      expect(isPrivateIpv4('172.16.0.1')).toBe(true);
      expect(isPrivateIpv4('172.31.255.254')).toBe(true);
      expect(isPrivateIpv4('172.15.255.255')).toBe(false); // Public
      expect(isPrivateIpv4('172.32.0.1')).toBe(false); // Public
      // Private Class C
      expect(isPrivateIpv4('192.168.1.1')).toBe(true);
      expect(isPrivateIpv4('192.168.254.254')).toBe(true);
      // Link-local / Cloud Metadata (169.254.0.0/16)
      expect(isPrivateIpv4('169.254.169.254')).toBe(true);
      // Current network (0.0.0.0/8)
      expect(isPrivateIpv4('0.0.0.0')).toBe(true);
      // CGNAT (100.64.0.0/10)
      expect(isPrivateIpv4('100.64.0.1')).toBe(true);
      expect(isPrivateIpv4('100.127.255.254')).toBe(true);
      // Multicast / Reserved
      expect(isPrivateIpv4('224.0.0.1')).toBe(true);
      expect(isPrivateIpv4('240.0.0.1')).toBe(true);
      expect(isPrivateIpv4('255.255.255.255')).toBe(true);

      // Public IPv4 addresses
      expect(isPrivateIpv4('93.184.216.34')).toBe(false); // example.com
      expect(isPrivateIpv4('8.8.8.8')).toBe(false); // Google DNS
      expect(isPrivateIpv4('1.1.1.1')).toBe(false); // Cloudflare DNS
    });

    it('should detect private and reserved IPv6 addresses', () => {
      expect(isPrivateIpv6('::1')).toBe(true); // Loopback
      expect(isPrivateIpv6('::')).toBe(true); // Unspecified
      expect(isPrivateIpv6('fc00::1')).toBe(true); // ULA
      expect(isPrivateIpv6('fd12:3456:789a::1')).toBe(true); // ULA
      expect(isPrivateIpv6('fe80::1')).toBe(true); // Link-local
      expect(isPrivateIpv6('ff02::1')).toBe(true); // Multicast
      // IPv4-mapped private
      expect(isPrivateIpv6('::ffff:127.0.0.1')).toBe(true);
      expect(isPrivateIpv6('::ffff:192.168.1.10')).toBe(true);
      expect(isPrivateIpv6('::ffff:93.184.216.34')).toBe(false); // IPv4-mapped public
    });

    it('should validate unified isPrivateIp helper', () => {
      expect(isPrivateIp('127.0.0.1')).toBe(true);
      expect(isPrivateIp('[::1]')).toBe(true);
      expect(isPrivateIp('10.1.2.3')).toBe(true);
      expect(isPrivateIp('93.184.216.34')).toBe(false);
      expect(isPrivateIp('invalid-ip')).toBe(true); // Malformed string treated as unsafe
    });

    it('should enforce HTTPS protocol by default and block non-HTTPS schemes', async () => {
      const httpResult = await validateSsrf('http://example.com/webhook');
      expect(httpResult.isValid).toBe(false);
      expect(httpResult.error).toContain("Disallowed protocol 'http:'");

      const ftpResult = await validateSsrf('ftp://example.com/webhook');
      expect(ftpResult.isValid).toBe(false);
      expect(ftpResult.error).toContain("Disallowed protocol 'ftp:'");

      // Allow http when explicitly opted in
      const mockDnsLookup = vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
      const allowHttpResult = await validateSsrf('http://example.com/webhook', {
        allowHttp: true,
        dnsLookup: mockDnsLookup,
      });
      expect(allowHttpResult.isValid).toBe(true);
    });

    it('should reject internal domain names (localhost, *.local, *.internal, *.lan)', async () => {
      const domains = [
        'https://localhost/webhook',
        'https://app.localhost/webhook',
        'https://database.local/api',
        'https://metadata.internal/creds',
        'https://router.lan/config',
      ];

      for (const domain of domains) {
        const result = await validateSsrf(domain);
        expect(result.isValid).toBe(false);
        expect(result.error).toMatch(/internal domain/i);
      }
    });

    it('should block URLs with direct private IP hostnames', async () => {
      const privateUrls = [
        'https://127.0.0.1:8080/hook',
        'https://10.0.0.5/api',
        'https://172.16.1.100/notify',
        'https://192.168.0.1/admin',
        'https://169.254.169.254/latest/meta-data',
        'https://[::1]/webhook',
        'https://[fc00::1]/alert',
      ];

      for (const url of privateUrls) {
        const result = await validateSsrf(url);
        expect(result.isValid).toBe(false);
        expect(result.error).toMatch(/private\/loopback/i);
      }

      // Should permit private IP when allowPrivateIps is explicitly true
      const allowedResult = await validateSsrf('https://127.0.0.1:8080/hook', {
        allowPrivateIps: true,
      });
      expect(allowedResult.isValid).toBe(true);
    });

    it('should perform DNS resolution and reject hostnames resolving to private IPs', async () => {
      const mockDnsLookup = vi.fn().mockResolvedValue([
        { address: '127.0.0.1', family: 4 },
      ]);

      const result = await validateSsrf('https://evil-redirect.attacker.com/webhook', {
        dnsLookup: mockDnsLookup,
      });

      expect(result.isValid).toBe(false);
      expect(result.error).toContain("resolves to private/loopback IP address '127.0.0.1'");
    });

    it('should reject multi-homed hostnames if any resolved IP is in a private subnet', async () => {
      const mockDnsLookup = vi.fn().mockResolvedValue([
        { address: '93.184.216.34', family: 4 }, // public IP
        { address: '10.0.0.1', family: 4 },      // internal IP
      ]);

      const result = await validateSsrf('https://mixed-resolution.com/webhook', {
        dnsLookup: mockDnsLookup,
      });

      expect(result.isValid).toBe(false);
      expect(result.error).toContain("resolves to private/loopback IP address '10.0.0.1'");
    });

    it('should allow valid public HTTPS destinations', async () => {
      const mockDnsLookup = vi.fn().mockResolvedValue([
        { address: '93.184.216.34', family: 4 },
      ]);

      const result = await validateSsrf('https://webhook.site/abcdef-1234', {
        dnsLookup: mockDnsLookup,
      });

      expect(result.isValid).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.resolvedIps).toEqual(['93.184.216.34']);
    });

    it('should handle malformed URLs and DNS failures gracefully', async () => {
      expect((await validateSsrf('')).isValid).toBe(false);
      expect((await validateSsrf('not-a-valid-url')).isValid).toBe(false);

      const failingDns = vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND invalid-domain.xyz'));
      const dnsFailureResult = await validateSsrf('https://invalid-domain.xyz/hook', {
        dnsLookup: failingDns,
      });
      expect(dnsFailureResult.isValid).toBe(false);
      expect(dnsFailureResult.error).toContain('DNS resolution failed');
    });

    it('assertSsrfSafe should throw on unsafe URLs and return safe URL string', async () => {
      await expect(assertSsrfSafe('https://127.0.0.1/hook')).rejects.toThrow(
        /SSRF validation blocked request/
      );

      const mockDnsLookup = vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
      const safe = await assertSsrfSafe('https://webhook.site/abc', { dnsLookup: mockDnsLookup });
      expect(safe).toBe('https://webhook.site/abc');
    });
  });

  // =========================================================================
  // 2. Custom Webhook & HMAC Signatures (src/notifiers/webhook.ts)
  // =========================================================================
  describe('Custom Webhook Dispatcher & HMAC Signing (src/notifiers/webhook)', () => {
    const mockSecret = 'whsec_9876543210fedcba9876543210fedcba';
    const mockPublicDns = vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);

    it('should compute deterministic HMAC-SHA256 signature matching expected digest', () => {
      const signature = computeWebhookSignature(sampleAlert, mockSecret);
      expect(typeof signature).toBe('string');
      expect(signature).toHaveLength(64); // 256 bits = 64 hex chars

      // Re-computing signature with identical inputs must yield identical digest
      const signature2 = computeWebhookSignature(sampleAlert, mockSecret);
      expect(signature).toBe(signature2);

      // Altering payload must change signature
      const modifiedPayload = { ...sampleAlert, title: 'Tampered Title' };
      const modifiedSignature = computeWebhookSignature(modifiedPayload, mockSecret);
      expect(modifiedSignature).not.toBe(signature);
    });

    it('should verify incoming webhook signatures with timing-safe comparison', () => {
      const payloadString = JSON.stringify(sampleAlert);
      const signatureHex = computeWebhookSignature(payloadString, mockSecret);

      // Format 1: raw hex
      expect(verifyWebhookSignature(payloadString, signatureHex, mockSecret)).toBe(true);

      // Format 2: sha256= prefix (GitHub / Stripe standard)
      expect(verifyWebhookSignature(payloadString, `sha256=${signatureHex}`, mockSecret)).toBe(true);

      // Verify with object payload
      expect(verifyWebhookSignature(sampleAlert, `sha256=${signatureHex}`, mockSecret)).toBe(true);

      // Mismatched secret
      expect(verifyWebhookSignature(payloadString, signatureHex, 'wrong-secret')).toBe(false);

      // Corrupted signature
      const corruptedSig = signatureHex.slice(0, -1) + (signatureHex.endsWith('a') ? 'b' : 'a');
      expect(verifyWebhookSignature(payloadString, corruptedSig, mockSecret)).toBe(false);

      // Empty signature or secret
      expect(verifyWebhookSignature(payloadString, '', mockSecret)).toBe(false);
      expect(verifyWebhookSignature(payloadString, signatureHex, '')).toBe(false);
    });

    it('should block webhook dispatch when destination fails SSRF validation', async () => {
      const mockFetch = vi.fn();
      const notifier = new WebhookNotifier({
        fetchFn: mockFetch as any,
      });

      const result = await notifier.send(sampleAlert, 'https://127.0.0.1:9000/webhook', mockSecret);

      expect(result.success).toBe(false);
      expect(result.error).toContain('SSRF validation blocked request');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should post raw JSON payload with signed X-Watchdog-Signature header on safe URL', async () => {
      let capturedUrl = '';
      let capturedOptions: any = null;

      const mockFetch = vi.fn().mockImplementation((url, opts) => {
        capturedUrl = url;
        capturedOptions = opts;
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
        });
      });

      const notifier = new WebhookNotifier({
        fetchFn: mockFetch as any,
        ssrfOptions: { dnsLookup: mockPublicDns },
      });

      const targetUrl = 'https://webhook.site/a8b9c0d1-2345';
      const result = await notifier.send(sampleAlert, targetUrl, mockSecret);

      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(capturedUrl).toBe(targetUrl);

      // Validate HTTP method and headers
      expect(capturedOptions.method).toBe('POST');
      expect(capturedOptions.headers['Content-Type']).toBe('application/json');
      expect(capturedOptions.headers['User-Agent']).toBe('Soroban-Watchdog/0.1.0');
      expect(capturedOptions.headers['X-Watchdog-Alert-Id']).toBe(sampleAlert.alertId);
      expect(capturedOptions.headers['X-Watchdog-Timestamp']).toBeDefined();

      // Validate HMAC signature header
      const signatureHeader = capturedOptions.headers['X-Watchdog-Signature'];
      expect(signatureHeader).toMatch(/^sha256=[0-9a-f]{64}$/);

      // Verify that the sent payload matches signature
      const sentBody = capturedOptions.body;
      expect(verifyWebhookSignature(sentBody, signatureHeader, mockSecret)).toBe(true);
      expect(JSON.parse(sentBody).alertId).toBe(sampleAlert.alertId);
    });

    it('should omit signature header when no secret is provided', async () => {
      let capturedOptions: any = null;
      const mockFetch = vi.fn().mockImplementation((_url, opts) => {
        capturedOptions = opts;
        return Promise.resolve({ ok: true, status: 204, statusText: 'No Content' });
      });

      const notifier = new WebhookNotifier({
        fetchFn: mockFetch as any,
        ssrfOptions: { dnsLookup: mockPublicDns },
      });

      const result = await notifier.send(sampleAlert, 'https://webhook.site/no-secret');
      expect(result.success).toBe(true);
      expect(capturedOptions.headers['X-Watchdog-Signature']).toBeUndefined();
    });

    it('should report HTTP error status codes gracefully', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        text: () => Promise.resolve('Upstream database down'),
      });

      const notifier = new WebhookNotifier({
        fetchFn: mockFetch as any,
        ssrfOptions: { dnsLookup: mockPublicDns },
      });

      const result = await notifier.send(sampleAlert, 'https://webhook.site/503-error');

      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(503);
      expect(result.error).toContain('Webhook destination returned HTTP 503 Service Unavailable');
      expect(result.error).toContain('Upstream database down');
    });

    it('should report network timeouts and connection errors gracefully', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));

      const notifier = new WebhookNotifier({
        fetchFn: mockFetch as any,
        ssrfOptions: { dnsLookup: mockPublicDns },
      });

      const result = await notifier.send(sampleAlert, 'https://webhook.site/network-fail');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Webhook request failed: connect ECONNREFUSED');
    });

    it('should validate missing or non-string destination URL', async () => {
      const notifier = new WebhookNotifier();
      const result = await notifier.send(sampleAlert, '');
      expect(result.success).toBe(false);
      expect(result.error).toContain('destination URL is required');
    });
  });

  // =========================================================================
  // 3. Discord Notifier & Color-Coded Embeds (src/notifiers/discord.ts)
  // =========================================================================
  describe('Discord Notifier & Embed Formatting (src/notifiers/discord)', () => {
    it('should map each severity level to its designated embed color code', () => {
      expect(SEVERITY_COLORS.CRITICAL).toBe(15158332); // #E74C3C Red
      expect(SEVERITY_COLORS.HIGH).toBe(15105570);     // #E67E22 Orange
      expect(SEVERITY_COLORS.MEDIUM).toBe(15844352);   // #F1C40F Yellow
      expect(SEVERITY_COLORS.LOW).toBe(3066993);       // #2ECC71 Green
    });

    it('should format Discord embed with all core alert fields and metadata', () => {
      const embed = buildDiscordEmbed(sampleAlert);

      expect(embed.color).toBe(SEVERITY_COLORS.CRITICAL);
      expect(embed.title).toContain(SEVERITY_BADGES.CRITICAL);
      expect(embed.title).toContain(sampleAlert.title);
      expect(embed.description).toBe(sampleAlert.message);
      expect(embed.url).toBe(sampleAlert.explorerUrl);
      expect(embed.timestamp).toBe('2026-10-26T12:00:00.000Z');

      const fieldNames = embed.fields.map((f) => f.name);
      expect(fieldNames).toContain('Contract ID');
      expect(fieldNames).toContain('Rule ID');
      expect(fieldNames).toContain('Severity');
      expect(fieldNames).toContain('Alert ID');
      expect(fieldNames).toContain('Stellar Explorer');
      expect(fieldNames).toContain('Amount');
      expect(fieldNames).toContain('Threshold');
      expect(fieldNames).toContain('Asset Symbol');

      const contractField = embed.fields.find((f) => f.name === 'Contract ID');
      expect(contractField?.value).toBe(`\`${sampleAlert.contractId}\``);

      const explorerField = embed.fields.find((f) => f.name === 'Stellar Explorer');
      expect(explorerField?.value).toContain(sampleAlert.explorerUrl);
    });

    it('should format embeds for HIGH, MEDIUM, and LOW alerts correctly', () => {
      const highAlert: AlertPayload = { ...sampleAlert, severity: 'HIGH' };
      const medAlert: AlertPayload = { ...sampleAlert, severity: 'MEDIUM' };
      const lowAlert: AlertPayload = { ...sampleAlert, severity: 'LOW' };

      expect(buildDiscordEmbed(highAlert).color).toBe(SEVERITY_COLORS.HIGH);
      expect(buildDiscordEmbed(highAlert).title).toContain('⚠️ [HIGH]');

      expect(buildDiscordEmbed(medAlert).color).toBe(SEVERITY_COLORS.MEDIUM);
      expect(buildDiscordEmbed(medAlert).title).toContain('🟡 [MEDIUM]');

      expect(buildDiscordEmbed(lowAlert).color).toBe(SEVERITY_COLORS.LOW);
      expect(buildDiscordEmbed(lowAlert).title).toContain('🟢 [LOW]');
    });

    it('should build complete Discord webhook payload with custom avatar and username', () => {
      const payload = buildDiscordPayload(sampleAlert, {
        username: 'Custom Watchtower',
        avatarUrl: 'https://example.com/logo.png',
      });

      expect(payload.username).toBe('Custom Watchtower');
      expect(payload.avatar_url).toBe('https://example.com/logo.png');
      expect(payload.embeds).toHaveLength(1);
      expect(payload.embeds[0].color).toBe(SEVERITY_COLORS.CRITICAL);
    });

    it('should validate Discord webhook URLs correctly', () => {
      expect(isValidDiscordWebhookUrl('https://discord.com/api/webhooks/1234567890/abcXYZ_123')).toBe(true);
      expect(isValidDiscordWebhookUrl('https://discordapp.com/api/webhooks/987654321/token')).toBe(true);

      // Invalid URLs
      expect(isValidDiscordWebhookUrl('http://discord.com/api/webhooks/123/abc')).toBe(false); // HTTP disallowed
      expect(isValidDiscordWebhookUrl('https://evil-site.com/api/webhooks/123/abc')).toBe(false); // Wrong host
      expect(isValidDiscordWebhookUrl('https://discord.com/channels/123/456')).toBe(false); // Not a webhook
      expect(isValidDiscordWebhookUrl('not-a-url')).toBe(false);
    });

    it('should reject invalid Discord webhook destination URLs', async () => {
      const notifier = new DiscordNotifier();
      const result = await notifier.send(sampleAlert, 'https://evil.com/webhook');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid Discord webhook URL');
    });

    it('should dispatch Discord embed message and handle HTTP 204 No Content', async () => {
      let capturedUrl = '';
      let capturedBody: any = null;

      const mockFetch = vi.fn().mockImplementation((url, opts) => {
        capturedUrl = url;
        capturedBody = JSON.parse(opts.body);
        return Promise.resolve({
          status: 204,
          statusText: 'No Content',
        });
      });

      const notifier = new DiscordNotifier({
        fetchFn: mockFetch as any,
      });

      const discordUrl = 'https://discord.com/api/webhooks/1122334455/abcdefToken_99';
      const result = await notifier.send(sampleAlert, discordUrl);

      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(204);
      expect(capturedUrl).toBe(discordUrl);
      expect(capturedBody.embeds).toHaveLength(1);
      expect(capturedBody.embeds[0].color).toBe(SEVERITY_COLORS.CRITICAL);
    });

    it('should handle Discord HTTP 429 rate limits and error responses', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        status: 429,
        statusText: 'Too Many Requests',
        text: () => Promise.resolve('{"retry_after": 2.5, "message": "You are being rate limited."}'),
      });

      const notifier = new DiscordNotifier({
        fetchFn: mockFetch as any,
      });

      const discordUrl = 'https://discord.com/api/webhooks/1122334455/abcdefToken_99';
      const result = await notifier.send(sampleAlert, discordUrl);

      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(429);
      expect(result.error).toContain('Discord webhook returned HTTP 429 Too Many Requests');
      expect(result.error).toContain('You are being rate limited');
    });
  });

  // =========================================================================
  // 4. Telegram Notifier (src/notifiers/telegram.ts)
  // =========================================================================
  describe('Telegram Notifier (src/notifiers/telegram)', () => {
    it('should format Telegram alert and dispatch to Bot API sendMessage', async () => {
      let capturedUrl = '';
      let capturedBody: any = null;

      const mockFetch = vi.fn().mockImplementation((url, opts) => {
        capturedUrl = url;
        capturedBody = JSON.parse(opts.body);
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
        });
      });

      const notifier = new TelegramNotifier({
        fetchFn: mockFetch as any,
      });

      const chatId = '-1001234567890';
      const botToken = '123456789:ABCdefGHI_token99';
      const result = await notifier.send(sampleAlert, chatId, botToken);

      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(200);
      expect(capturedUrl).toBe(`https://api.telegram.org/bot${botToken}/sendMessage`);
      expect(capturedBody.chat_id).toBe(chatId);
      expect(capturedBody.parse_mode).toBe('Markdown');
      expect(capturedBody.text).toContain('*[CRITICAL]*');
      expect(capturedBody.text).toContain(sampleAlert.contractId);
      expect(capturedBody.text).toContain(sampleAlert.explorerUrl);
    });

    it('should fail when destination or bot token is missing', async () => {
      const notifier = new TelegramNotifier();
      const noDestResult = await notifier.send(sampleAlert, '');
      expect(noDestResult.success).toBe(false);
      expect(noDestResult.error).toContain('destination (chat_id) is required');

      const noTokenResult = await notifier.send(sampleAlert, '-100123');
      expect(noTokenResult.success).toBe(false);
      expect(noTokenResult.error).toContain('Telegram bot token is required');
    });
  });

  // =========================================================================
  // 5. Default Registry & Queue Integration
  // =========================================================================
  describe('Default Notifier Registry & Queue Worker Integration', () => {
    it('should construct registry containing DISCORD, WEBHOOK, and TELEGRAM plugins', () => {
      const registry = createDefaultNotifierRegistry();

      expect(registry.has('DISCORD')).toBe(true);
      expect(registry.has('WEBHOOK')).toBe(true);
      expect(registry.has('TELEGRAM')).toBe(true);

      expect(registry.get('DISCORD')?.type).toBe('DISCORD');
      expect(registry.get('WEBHOOK')?.type).toBe('WEBHOOK');
      expect(registry.get('TELEGRAM')?.type).toBe('TELEGRAM');
    });

    it('should integrate registry directly into AlertWorkerConsumer to dispatch live alerts', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
      });

      const registry = createDefaultNotifierRegistry({
        webhook: {
          fetchFn: mockFetch as any,
          ssrfOptions: {
            dnsLookup: vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
          },
        },
      });

      const mockWorker: any = {
        on: vi.fn(),
        close: vi.fn(),
      };

      const consumer = new AlertWorkerConsumer({
        underlyingWorker: mockWorker,
        notifiers: registry,
      });

      const mockJob: any = {
        id: 'job-webhook-dispatch',
        attemptsMade: 0,
        data: {
          alertId: sampleAlert.alertId,
          channelType: 'WEBHOOK',
          destination: 'https://webhook.site/test-integration',
          secret: 'whsec_test_secret_12345',
          payload: sampleAlert,
        },
      };

      const result = await consumer.processJob(mockJob);
      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });
});
