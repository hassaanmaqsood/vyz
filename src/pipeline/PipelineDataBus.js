/**
 * PipelineDataBus - Cross-Pipeline Reactive Event & Telemetry Broker
 * Enables real-time data sharing between independent media pipelines
 * (e.g. Mic speech recognition feeding video subtitles, or audio levels driving active speaker AR).
 */

class PipelineDataBus {
    constructor() {
        this.listeners = new Map();
        this.latestValues = new Map();
        this.syncHandler = null; // Optional external network sync (WebRTC DataChannel / RPC)
    }

    /**
     * Subscribe to a specific pipeline topic
     * @param {string} topic - e.g. 'pipeline:speech:transcript', 'pipeline:audio:level'
     * @param {Function} callback - (data) => void
     * @returns {Function} unsubscribe function
     */
    subscribe(topic, callback) {
        if (!this.listeners.has(topic)) {
            this.listeners.set(topic, new Set());
        }
        this.listeners.get(topic).add(callback);

        // Immediately emit latest cached value if present
        if (this.latestValues.has(topic)) {
            try {
                callback(this.latestValues.get(topic));
            } catch (e) {
                console.error(`[PipelineDataBus] Error in immediate listener for ${topic}:`, e);
            }
        }

        return () => {
            const set = this.listeners.get(topic);
            if (set) {
                set.delete(callback);
                if (set.size === 0) {
                    this.listeners.delete(topic);
                }
            }
        };
    }

    /**
     * Publish an event onto the bus
     * @param {string} topic
     * @param {any} data
     * @param {boolean} [syncToRemote=true] - Whether to replicate via RPC to peers
     */
    publish(topic, data, syncToRemote = true) {
        this.latestValues.set(topic, data);

        const set = this.listeners.get(topic);
        if (set) {
            set.forEach(cb => {
                try {
                    cb(data);
                } catch (err) {
                    console.error(`[PipelineDataBus] Listener error on ${topic}:`, err);
                }
            });
        }

        if (syncToRemote && this.syncHandler) {
            this.syncHandler(topic, data);
        }
    }

    /**
     * Get the latest published value for a topic
     * @param {string} topic
     * @returns {any}
     */
    getLatest(topic) {
        return this.latestValues.get(topic);
    }

    /**
     * Attach a network replication handler for peer RPC
     * @param {Function} handler - (topic, data) => void
     */
    setNetworkSync(handler) {
        this.syncHandler = handler;
    }

    /**
     * Ingest remote sync event (without re-broadcasting back to network)
     */
    ingestRemoteSync(topic, data) {
        this.publish(topic, data, false);
    }

    clear() {
        this.listeners.clear();
        this.latestValues.clear();
    }
}

// Export as ES Module or window global
if (typeof window !== 'undefined') {
    window.PipelineDataBus = PipelineDataBus;
    window.globalDataBus = new PipelineDataBus();
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PipelineDataBus };
}
