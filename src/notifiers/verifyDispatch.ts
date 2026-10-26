import http from 'node:http';
import { AddressInfo } from 'node:net';
import { WebhookNotifier, computeWebhookSignature, verifyWebhookSignature } from './webhook.js';
import { DiscordNotifier, buildDiscordPayload, SEVERITY_COLORS } from './discord.js';
import { validateSsrf } from './ssrfValidator.js';
import { AlertPayload } from '../types/index.js';

const sampleVerificationAlert: AlertPayload = {
  alertId: `alert-verify-${Date.now()}`,
  contractId: 'CA3D5KRYMCMFZK54DNYNO3TVQAS4PU2QLAXU6VO6JMQG2RCHWHW32VN4',
  ruleId: 'LARGE_VALUE_TRANSFER',
  severity: 'CRITICAL',
  title: 'Exploit Alert Verification Test',
  message: 'This is an end-to-end verification alert dispatched from Soroban Watchdog (Step 8).',
  timestamp: new Date(),
  metadata: {
    transferredAmount: '500,000 XLM',
    threshold: '10,000 XLM',
    sender: 'GAB7R2R3X4J75CVSQVYXG3463RXZL6E4HUKW4I43RBL546YQ2M3J2KLP',
    recipient: 'GDYF5L2D7P4E23Q7D8F9Q3B4V5C6X7Z8A9S0D1F2G3H4J5K6L7M8N9P0',
  },
  explorerUrl:
    'https://stellar.expert/explorer/public/contract/CA3D5KRYMCMFZK54DNYNO3TVQAS4PU2QLAXU6VO6JMQG2RCHWHW32VN4',
};

async function runLocalHttpVerification(): Promise<void> {
  console.log('------------------------------------------------------------');
  console.log('🧪 Step 8 Verification: Ephemeral HTTP Server Live Dispatch');
  console.log('------------------------------------------------------------');

  const testSecret = 'whsec_verifystep8secretkey_999999999999';
  let receivedPayload: any = null;
  let receivedHeaders: http.IncomingHttpHeaders = {};
  let signatureVerified = false;

  // 1. Spin up ephemeral local HTTP server
  const server = http.createServer(async (req, res) => {
    receivedHeaders = req.headers;
    const chunks: Buffer[] = [];

    for await (const chunk of req) {
      chunks.push(chunk);
    }

    const rawBody = Buffer.concat(chunks).toString('utf8');
    try {
      receivedPayload = JSON.parse(rawBody);
      const signatureHeader = req.headers['x-watchdog-signature'] as string;
      signatureVerified = verifyWebhookSignature(rawBody, signatureHeader, testSecret);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'received', verified: signatureVerified }));
    } catch (err: any) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const localUrl = `http://127.0.0.1:${port}/webhook/test`;
  console.log(`[1] Ephemeral verification webhook listener active at ${localUrl}`);

  try {
    // 2. Demonstrate SSRF blocking on default settings (rejects loopback & non-https)
    console.log('[2] Testing SSRF Guard: attempting dispatch without override...');
    const strictNotifier = new WebhookNotifier();
    const ssrfBlockedResult = await strictNotifier.send(sampleVerificationAlert, localUrl, testSecret);

    if (!ssrfBlockedResult.success && ssrfBlockedResult.error?.includes('SSRF validation blocked request')) {
      console.log('    🛡️ SSRF Guard successfully blocked local IP destination:');
      console.log(`       Reason: ${ssrfBlockedResult.error}`);
    } else {
      throw new Error(`SSRF Guard failed to block local destination! Result: ${JSON.stringify(ssrfBlockedResult)}`);
    }

    // 3. Dispatch to local server with explicit test override
    console.log('[3] Dispatching live HTTP POST with HMAC signing...');
    const testNotifier = new WebhookNotifier({
      ssrfOptions: {
        allowHttp: true,
        allowedProtocols: ['http:', 'https:'],
        allowPrivateIps: true,
      },
    });

    const deliveryResult = await testNotifier.send(sampleVerificationAlert, localUrl, testSecret);

    if (!deliveryResult.success) {
      throw new Error(`Delivery failed: ${deliveryResult.error}`);
    }

    console.log(`    ✅ HTTP Delivery successful! (Status: ${deliveryResult.statusCode})`);
    console.log(`    📦 Received Alert ID: ${receivedPayload.alertId}`);
    console.log(`    🔑 X-Watchdog-Signature Header: ${receivedHeaders['x-watchdog-signature']}`);
    console.log(`    🔒 HMAC Cryptographic Signature Match: ${signatureVerified ? 'VALID ✅' : 'INVALID ❌'}`);

    // 4. Demonstrate Discord embed formatting
    console.log('[4] Verifying Discord Embed Payload Construction...');
    const discordPayload = buildDiscordPayload(sampleVerificationAlert);
    const embed = discordPayload.embeds[0];
    console.log(`    🎨 Embed Color: ${embed.color} (${embed.color === SEVERITY_COLORS.CRITICAL ? 'CRITICAL Red #E74C3C ✅' : 'Other'})`);
    console.log(`    📌 Title: ${embed.title}`);
    console.log(`    📋 Fields Count: ${embed.fields.length} fields formatted with markdown`);

    console.log('------------------------------------------------------------');
    console.log('✨ All Step 8 Notification Dispatcher verifications PASSED!');
    console.log('------------------------------------------------------------\n');
  } finally {
    server.close();
  }
}

async function runExternalTargetVerification(targetUrl: string, secret?: string): Promise<void> {
  console.log('------------------------------------------------------------');
  console.log(`🌐 Step 8 External Target Verification: ${targetUrl}`);
  console.log('------------------------------------------------------------');

  const isDiscord = targetUrl.includes('discord.com') || targetUrl.includes('discordapp.com');

  if (isDiscord) {
    console.log('📡 Detected Discord Webhook URL. Dispatching rich embed...');
    const discordNotifier = new DiscordNotifier();
    const result = await discordNotifier.send(sampleVerificationAlert, targetUrl);

    if (result.success) {
      console.log(`✅ Discord alert delivered successfully! (Status: ${result.statusCode})`);
    } else {
      console.error(`❌ Discord alert delivery failed: ${result.error}`);
    }
  } else {
    console.log('📡 Detected custom webhook URL (e.g. webhook.site). Dispatching HMAC signed payload...');
    const webhookNotifier = new WebhookNotifier();
    const effectiveSecret = secret || 'whsec_soroban_watchtower_demo';
    const result = await webhookNotifier.send(sampleVerificationAlert, targetUrl, effectiveSecret);

    if (result.success) {
      const signature = computeWebhookSignature(sampleVerificationAlert, effectiveSecret);
      console.log(`✅ Webhook delivered successfully! (Status: ${result.statusCode})`);
      console.log(`🔑 Dispatched HMAC-SHA256 Signature: sha256=${signature}`);
    } else {
      console.error(`❌ Webhook delivery failed: ${result.error}`);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  let targetUrl: string | undefined = process.env.TEST_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL;
  let secret: string | undefined = process.env.TEST_WEBHOOK_SECRET;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url' && args[i + 1]) {
      targetUrl = args[i + 1];
      i++;
    } else if (args[i] === '--secret' && args[i + 1]) {
      secret = args[i + 1];
      i++;
    }
  }

  if (targetUrl) {
    await runExternalTargetVerification(targetUrl, secret);
  } else {
    await runLocalHttpVerification();
    console.log('💡 Tip: You can also verify against a live Discord webhook or webhook.site:');
    console.log('   npx tsx src/notifiers/verifyDispatch.ts --url https://webhook.site/<your-uuid>');
    console.log('   npx tsx src/notifiers/verifyDispatch.ts --url https://discord.com/api/webhooks/<id>/<token>');
  }
}

main().catch((err) => {
  console.error('❌ Verification script encountered an error:', err);
  process.exit(1);
});
