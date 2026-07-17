import { describe, expect, test } from 'bun:test';
import packageJson from '../../package.json';
import { MCP_VERSION } from './version';

describe('MCP_VERSION', () => {
  test('matches the published core package version', () => {
    expect(MCP_VERSION).toBe(packageJson.version);
  });
});
