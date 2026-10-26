/**
 * CDP Session Manager
 *
 * Manages Playwright CDP connection to existing Chrome instance.
 * Connection is cached for reuse across operations.
 */

import { chromium, Browser, BrowserContext } from 'playwright-core';
import * as net from 'net';
import { CDPConfig, CDPConnection, DEFAULT_CDP_CONFIG } from './types';

/** Cached connection */
let cachedConnection: CDPConnection | null = null;

/**
 * Check if CDP port is available
 */
export async function isCDPPortOpen(port: number = 9222): Promise<boolean> {
  return new Promise((resolve) => {
    const client = new net.Socket();
    const timeout = setTimeout(() => {
      client.destroy();
      resolve(false);
    }, 1000);

    client.connect(port, '127.0.0.1', () => {
      clearTimeout(timeout);
      client.destroy();
      resolve(true);
    });

    client.on('error', () => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
}

/**
 * Connect to existing Chrome via CDP
 */
export async function connectCDP(
  config: Partial<CDPConfig> = {}
): Promise<CDPConnection> {
  const fullConfig = { ...DEFAULT_CDP_CONFIG, ...config };

  // Return cached connection if still valid
  if (cachedConnection?.isConnected) {
    try {
      // Verify connection is still alive
      await cachedConnection.browser.contexts();
      return cachedConnection;
    } catch (error) {
      // Connection is stale, clear cache and log for diagnostics
      console.debug('[CDP] Cached connection stale, reconnecting:', error instanceof Error ? error.message : String(error));
      cachedConnection = null;
    }
  }

  // Extract port from endpoint URL
  const portMatch = fullConfig.endpointUrl.match(/:(\d+)/);
  const port = portMatch ? parseInt(portMatch[1], 10) : 9222;

  // Check if Chrome is running
  const isOpen = await isCDPPortOpen(port);
  if (!isOpen) {
    throw new Error(
      `Chrome is not running on port ${port}. ` +
        'Start Chrome with: npm run chrome:debug:start'
    );
  }

  // Connect via CDP
  let browser: Browser;
  let attempts = 0;

  while (attempts < fullConfig.maxRetries) {
    try {
      browser = await chromium.connectOverCDP(fullConfig.endpointUrl, {
        timeout: fullConfig.timeout,
      });
      break;
    } catch (err) {
      attempts++;
      if (attempts >= fullConfig.maxRetries) {
        throw new Error(
          `Failed to connect to Chrome after ${fullConfig.maxRetries} attempts: ${err}`,
          { cause: err }
        );
      }
      // Wait before retry
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  // Get existing context (preserves login state) or create new one
  const contexts = browser!.contexts();
  const context: BrowserContext =
    contexts.length > 0 ? contexts[0] : await browser!.newContext();

  cachedConnection = {
    browser: browser!,
    context,
    isConnected: true,
  };

  // Handle disconnect
  browser!.on('disconnected', () => {
    if (cachedConnection) {
      cachedConnection.isConnected = false;
    }
  });

  return cachedConnection;
}

/**
 * Get cached connection if available
 */
export function getCachedConnection(): CDPConnection | null {
  if (cachedConnection?.isConnected) {
    return cachedConnection;
  }
  return null;
}

/**
 * Disconnect from Chrome (does NOT close Chrome, just releases connection)
 */
export async function disconnectCDP(): Promise<void> {
  if (cachedConnection) {
    try {
      // Just disconnect, don't close browser
      await cachedConnection.browser.close();
    } catch (error) {
      // Log at debug level for diagnostics, but don't fail
      console.debug('[CDP] Error during disconnect (non-fatal):', error instanceof Error ? error.message : String(error));
    }
    cachedConnection = null;
  }
}

/**
 * Clear cached connection (for testing)
 */
export function clearConnectionCache(): void {
  cachedConnection = null;
}
