#!/usr/bin/env node
/**
 * Scenario: build a client `.ovpn` with the config builder (offline).
 *
 *   npm run playground:config
 *   npm run playground:config -- --out ./playground-client.ovpn
 */
import { readFile, stat } from 'node:fs/promises';
import { OvpnConfig } from 'openvpn-node-sdk';
import { dim, EXIT_FAIL, parseArgs, Reporter, withTempDir, yellow } from './lib.mjs';

const args = parseArgs();
const reporter = new Reporter('playground:config');

const CA = [
  '-----BEGIN CERTIFICATE-----',
  'MIIBplaygroundCA0000000000000000000000000000000000000000000',
  '-----END CERTIFICATE-----',
].join('\n');
const CERT = [
  '-----BEGIN CERTIFICATE-----',
  'MIIBplaygroundCert00000000000000000000000000000000000000000',
  '-----END CERTIFICATE-----',
].join('\n');
const KEY = [
  '-----BEGIN PRIVATE KEY-----',
  'MIIBplaygroundKey000000000000000000000000000000000000000000',
  '-----END PRIVATE KEY-----',
].join('\n');

function build() {
  return new OvpnConfig()
    .client()
    .remote('vpn.example.com', 1194, 'udp')
    .dev('tun')
    .devNode('Playground Adapter')
    .authUserPass()
    .caInline(CA)
    .certInline(CERT)
    .keyInline(KEY)
    .setenv('PLAYGROUND', '1')
    .raw('verb', '3');
}

async function main() {
  const config = build();
  const text = config.toString();
  const target = args.get('out');

  reporter.section('generated .ovpn');
  for (const line of text.trimEnd().split('\n')) console.log(dim(`   ${line}`));

  reporter.expect(text.startsWith('client\n'), 'starts with `client`');
  reporter.expect(text.includes('remote vpn.example.com 1194 udp'), 'resolves remote host/port/proto');
  reporter.expect(text.includes('dev-node "Playground Adapter"'), 'quotes dev-node with a space');
  reporter.expect(text.endsWith('\n'), 'ends with a newline');
  for (const block of ['ca', 'cert', 'key']) {
    const open = `<${block}>`;
    const close = `</${block}>`;
    const openAt = text.indexOf(open);
    const closeAt = text.indexOf(close);
    reporter.expect(openAt !== -1 && closeAt > openAt, `inline <${block}> block is well formed`);
  }

  reporter.section('write to disk');
  if (target) {
    await config.writeTo(target);
    const info = await stat(target);
    reporter.ok(`wrote ${info.size} bytes`);
    reporter.info(`          ${target}`);
    const roundTrip = await readFile(target, 'utf8');
    reporter.expect(roundTrip === text, 'bytes on disk match the builder output');
  } else {
    await withTempDir(async (dir) => {
      const file = `${dir}/client.ovpn`;
      await config.writeTo(file);
      const info = await stat(file);
      reporter.ok(`temporary write succeeded (${info.size} bytes)`);
      reporter.info(`          ${file} (removed on exit)`);
      reporter.expect((await readFile(file, 'utf8')) === text, 'bytes on disk match the builder output');
    }, 'ovpn-pg-config-');
    reporter.info(dim('   pass --out <path> to keep a copy'));
  }

  return reporter.summary();
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(yellow('playground:config crashed:'), err);
    process.exitCode = EXIT_FAIL;
  });
