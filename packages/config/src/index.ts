import { writeFile } from 'node:fs/promises';
import { escapeArg } from '@ovpn-sdk/core';

/**
 * OvpnConfig: builder object model -> .ovpn text.
 *
 * Supports inline <ca>/<cert>/<key> blocks (OpenVPN inline file syntax),
 * auth-user-pass, dev-node and arbitrary raw directives.
 */
export class OvpnConfig {
  private readonly lines: string[] = [];

  client(): this {
    this.lines.push('client');
    return this;
  }

  remote(host: string, port: number, proto: 'udp' | 'tcp' = 'udp'): this {
    this.lines.push(`remote ${escapeArg(host)} ${port} ${proto}`);
    return this;
  }

  proto(proto: 'udp' | 'tcp'): this {
    this.lines.push(`proto ${proto}`);
    return this;
  }

  dev(dev: string): this {
    this.lines.push(`dev ${escapeArg(dev)}`);
    return this;
  }

  devNode(name: string): this {
    this.lines.push(`dev-node ${escapeArg(name)}`);
    return this;
  }

  authUserPass(): this {
    this.lines.push('auth-user-pass');
    return this;
  }

  caInline(pem: string): this {
    this.pushInline('ca', pem);
    return this;
  }

  certInline(pem: string): this {
    this.pushInline('cert', pem);
    return this;
  }

  keyInline(pem: string): this {
    this.pushInline('key', pem);
    return this;
  }

  setenv(name: string, value: string): this {
    this.lines.push(`setenv ${escapeArg(name)} ${escapeArg(value)}`);
    return this;
  }

  raw(directive: string, value = ''): this {
    this.lines.push(value === '' ? directive : `${directive} ${value}`);
    return this;
  }

  toString(): string {
    return this.lines.join('\n') + '\n';
  }

  async writeTo(path: string): Promise<void> {
    await writeFile(path, this.toString(), 'utf8');
  }

  private pushInline(directive: string, pem: string): void {
    const body = pem.trim().replace(/\r\n/g, '\n');
    this.lines.push(`<${directive}>`);
    for (const line of body.split('\n')) {
      this.lines.push(line);
    }
    this.lines.push(`</${directive}>`);
  }
}
