const DiscordRPC = require('discord-rpc');

const DEFAULT_CLIENT_ID = '1343602498263548004';

class MintPyDiscordRPC {
  constructor() {
    this.rpc = null;
    this.clientId = DEFAULT_CLIENT_ID;
    this.enabled = true;
    this.connected = false;
    this.reconnectTimer = null;
    this.currentActivity = null;
  }

  init(enabled = true, clientId = null) {
    this.enabled = enabled !== false;
    if (clientId && typeof clientId === 'string') this.clientId = clientId;
    if (this.enabled) {
      this.connect();
    } else {
      this.destroy();
    }
  }

  connect() {
    if (this.connected || this.rpc || !this.enabled) return;
    try {
      this.rpc = new DiscordRPC.Client({ transport: 'ipc' });

      this.rpc.on('ready', () => {
        this.connected = true;
        console.log('[Discord RPC] Connected and ready');
        if (this.currentActivity) {
          this.setActivity(this.currentActivity);
        }
      });

      this.rpc.on('error', (err) => {
        console.warn('[Discord RPC] Error:', err?.message || err);
      });

      if (this.rpc.transport) {
        this.rpc.transport.on('close', () => {
          this.connected = false;
          this.rpc = null;
          this.scheduleReconnect();
        });
      }

      this.rpc.login({ clientId: this.clientId }).catch((err) => {
        this.connected = false;
        this.rpc = null;
        this.scheduleReconnect();
      });
    } catch (e) {
      this.connected = false;
      this.rpc = null;
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    if (!this.enabled || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.enabled && !this.connected) {
        this.connect();
      }
    }, 15000);
  }

  setActivity({ title, artist, duration, position, isPlaying, style } = {}) {
    this.currentActivity = { title, artist, duration, position, isPlaying, style };
    if (!this.rpc || !this.connected || !this.enabled) return;

    try {
      if (!title) {
        this.rpc.setActivity({
          details: 'В медитации 🌿',
          state: `Стиль: ${style ? (style.charAt(0).toUpperCase() + style.slice(1)) : 'Zen'}`,
          largeImageKey: 'mintpy_logo',
          largeImageText: 'MintPy — Дзэн-плеер',
          instance: false
        }).catch(() => {});
        return;
      }

      const activity = {
        details: String(title).slice(0, 128),
        state: (artist ? `от ${artist}` : `Стиль: ${style || 'Zen'}`).slice(0, 128),
        largeImageKey: 'mintpy_logo',
        largeImageText: 'MintPy v5.3.8 — Дзэн-плеер',
        smallImageKey: isPlaying ? 'play' : 'pause',
        smallImageText: isPlaying ? 'Воспроизведение' : 'Пауза',
        instance: false
      };

      const now = Math.floor(Date.now() / 1000);
      const pos = Math.max(0, Math.floor(position || 0));

      if (isPlaying && duration && duration > 0) {
        activity.startTimestamp = now - pos;
        activity.endTimestamp = now - pos + Math.floor(duration);
      } else if (isPlaying) {
        activity.startTimestamp = now - pos;
      }

      this.rpc.setActivity(activity).catch(() => {});
    } catch (err) {
      console.warn('[Discord RPC] setActivity failed:', err.message);
    }
  }

  clearActivity() {
    this.currentActivity = null;
    if (this.rpc && this.connected) {
      this.rpc.clearActivity().catch(() => {});
    }
  }

  destroy() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearActivity();
    if (this.rpc) {
      try { this.rpc.destroy(); } catch {}
      this.rpc = null;
    }
    this.connected = false;
  }
}

module.exports = new MintPyDiscordRPC();
