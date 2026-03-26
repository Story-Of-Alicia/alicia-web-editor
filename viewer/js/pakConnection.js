// WebSocket client for the Alicia editor PAK protocol.
// Protocol shape:
// {
//   "endpoint": "pak" | "asset",
//   "payload": {
//     "operation": "...",
//     ...
//   }
// }

const DEFAULT_URL = 'ws://localhost:8083';

export class PakConnection {
  constructor(url = DEFAULT_URL) {
    this.url = url;
    this.ws = null;
    this.resourcePath = '';
    this._pending = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error('WebSocket connection failed'));
      this.ws.onclose = () => {
        for (const p of this._pending) p.reject(new Error('Connection closed'));
        this._pending = [];
      };
      this.ws.onmessage = (event) => this._onMessage(event);
    });
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async openPak() {
    const prompt = await this.promptPak();
    const resourcePath = String(prompt?.resource_path ?? '').trim();
    if (!resourcePath) throw new Error('No PAK path selected');
    const listing = await this.readPak(resourcePath);
    return { resource_path: resourcePath, assets: listing?.assets ?? [] };
  }

  async promptPak() {
    return this._sendRequest('pak', { operation: 'prompt' });
  }

  async readPak(resourcePath = this.resourcePath) {
    const path = String(resourcePath ?? '').trim();
    if (!path) throw new Error('PAK resource path is empty');
    const response = await this._sendRequest('pak', {
      operation: 'read',
      resource_path: path,
    });
    this.resourcePath = path;
    return {
      resource_path: path,
      assets: this._normaliseAssetEntries(response?.assets ?? []),
    };
  }

  async writePak(resourcePath = this.resourcePath, targetResourcePath = '') {
    const path = String(resourcePath ?? '').trim();
    if (!path) throw new Error('PAK resource path is empty');
    const payload = {
      operation: 'write',
      resource_path: path,
    };
    const targetPath = String(targetResourcePath ?? '').trim();
    if (targetPath) payload.target_resource_path = targetPath;

    const response = await this._sendRequest('pak', payload);
    this.resourcePath = path;
    return response ?? {};
  }

  async invalidatePak(resourcePath = this.resourcePath) {
    const path = String(resourcePath ?? '').trim();
    if (!path) return {};
    const response = await this._sendRequest('pak', {
      operation: 'invalidate',
      resource_path: path,
    });
    if (this.resourcePath === path) this.resourcePath = '';
    return response ?? {};
  }

  async fetchAsset(assetPath, resourcePath = this.resourcePath) {
    const path = this._normaliseAssetPath(assetPath);
    const resource = String(resourcePath ?? '').trim();
    if (!resource) throw new Error('PAK resource path is empty');
    if (!path) throw new Error('Asset path is empty');

    const response = await this._sendRequest('asset', {
      operation: 'read',
      resource_path: resource,
      asset_path: path,
    });

    const bytes = this._coerceByteArray(response?.data);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }

  async writeAsset(assetPath, data, resourcePath = this.resourcePath) {
    const path = this._normaliseAssetPath(assetPath);
    const resource = String(resourcePath ?? '').trim();
    if (!resource) throw new Error('PAK resource path is empty');
    if (!path) throw new Error('Asset path is empty');
    const bytes = this._coerceByteArray(data);

    return this._sendRequest('asset', {
      operation: 'write',
      resource_path: resource,
      asset_path: path,
      data: [...bytes],
    });
  }

  _coerceByteArray(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (Array.isArray(value)) return Uint8Array.from(value);
    throw new Error('Asset data is not a byte array');
  }

  _normaliseAssetPath(path) {
    return String(path ?? '').trim().replace(/\\/g, '/');
  }

  _normaliseAssetEntries(assets) {
    if (!Array.isArray(assets)) return [];
    return assets.map((entry) => {
      const next = { ...(entry ?? {}) };
      if (typeof next.path === 'string') {
        next.path = this._normaliseAssetPath(next.path);
      }
      return next;
    });
  }

  _sendRequest(endpoint, payload) {
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        reject(new Error('Not connected'));
        return;
      }

      this._pending.push({ resolve, reject });
      const safePayload = { ...(payload ?? {}) };
      if (endpoint === 'asset' && typeof safePayload.asset_path === 'string') {
        safePayload.asset_path = this._normaliseAssetPath(safePayload.asset_path);
      }

      this.ws.send(JSON.stringify({ endpoint, payload: safePayload }));
    });
  }

  _onMessage(event) {
    if (event.data instanceof ArrayBuffer) {
      const pending = this._pending.shift();
      if (pending) pending.reject(new Error('Unexpected binary response'));
      return;
    }

    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    const pending = this._pending.shift();
    if (!pending) return;

    if (msg && typeof msg.error === 'string' && msg.error.length) {
      pending.reject(new Error(msg.error));
      return;
    }
    pending.resolve(msg);
  }
}
