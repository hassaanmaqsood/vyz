/**
 * PeerRPC - Production-Grade WebRTC & Signaling RPC Manager for VYZ Studio
 * Supports Public STUN servers, user-configured custom WebRTC servers (STUN/TURN),
 * dynamic multi-source negotiation per participant, independent audio/video track RPC toggles,
 * and host-to-peer merged studio broadcast distribution.
 * Fully compatible with GitHub Pages static hosting & local/self-hosted Node environments.
 */

const DEFAULT_PUBLIC_ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
];

class PeerRPC {
    constructor(options = {}) {
        this.role = options.role || 'host'; // 'host' | 'participant' | 'viewer'
        this.roomId = options.roomId || 'vyz-studio';
        this.peerId = options.peerId || `peer-${Math.random().toString(36).substr(2, 6)}`;
        this.userName = options.userName || (this.role === 'host' ? 'Host' : 'Participant');
        this.polite = this.role !== 'host'; // Host is impolite, participants are polite

        this.dataBus = options.dataBus || (typeof window !== 'undefined' ? window.globalDataBus : null);
        
        // ICE Servers resolution: Custom saved in localStorage > options > server API > public defaults
        this.iceServers = this.loadConfiguredIceServers() || options.iceServers || DEFAULT_PUBLIC_ICE_SERVERS;

        // Custom Signaling URL
        this.customSignalingUrl = options.signalingUrl || this.loadConfiguredSignalingUrl();

        this.ws = null;
        this.broadcastChannel = null;
        
        // Peer state maps: targetPeerId -> state
        this.rtcPeers = new Map();         // peerId -> RTCPeerConnection
        this.dataChannels = new Map();     // peerId -> RTCDataChannel
        this.makingOffer = new Map();      // peerId -> boolean
        this.ignoreOffer = new Map();      // peerId -> boolean
        this.candidateQueues = new Map();  // peerId -> Array<RTCIceCandidateInit>
        this.remoteStreams = new Map();    // streamId -> MediaStream
        this.peerMetadata = new Map();     // peerId -> { name, role }

        // Local media sources: sourceId -> { stream, metadata }
        this.localSources = new Map();
        this.mergedBroadcastStream = null;
        this.isBroadcastingMerged = false;

        // Callbacks
        this.onRemoteStreamReceived = null; // (peerId, stream, metadata) => void
        this.onRemoteStreamRemoved = null;  // (peerId, streamId) => void
        this.onPermissionRequested = null;  // ({ sourceId, requesterName }, resolve) => void
        this.onRemoteToggleReceived = null; // ({ sourceId, active }) => void
        this.onTrackToggleReceived = null;  // ({ sourceId, trackKind, enabled, byHost }) => void
        this.onPipelineConfigUpdated = null;// ({ sourceId, config }) => void
        this.onPeerListChanged = null;       // (peersArray) => void
        this.onConnectionStatus = null;     // (statusString) => void
        this.onBroadcastStatusReceived = null; // ({ peerId, active }) => void

        this.connectedPeers = new Set();

        this._fetchIceServers();
        this._initSignaling();
        this._initDataBusBridge();
    }

    /**
     * Check if currently running on a static host (GitHub Pages or local file)
     */
    static isStaticHosting() {
        if (typeof window === 'undefined') return false;
        return window.location.hostname.endsWith('github.io') || window.location.protocol === 'file:';
    }

    loadConfiguredIceServers() {
        if (typeof window === 'undefined' || !window.localStorage) return null;
        try {
            const raw = localStorage.getItem('vyz_custom_ice_servers');
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    return parsed;
                }
            }
        } catch (e) {
            console.warn('[PeerRPC] Failed to parse custom ICE servers from localStorage:', e);
        }
        return null;
    }

    loadConfiguredSignalingUrl() {
        if (typeof window === 'undefined' || !window.localStorage) return null;
        return localStorage.getItem('vyz_signaling_url') || null;
    }

    setCustomIceServers(serversArray) {
        if (!Array.isArray(serversArray) || serversArray.length === 0) {
            this.iceServers = DEFAULT_PUBLIC_ICE_SERVERS;
            if (typeof window !== 'undefined' && window.localStorage) {
                localStorage.removeItem('vyz_custom_ice_servers');
            }
        } else {
            this.iceServers = serversArray;
            if (typeof window !== 'undefined' && window.localStorage) {
                localStorage.setItem('vyz_custom_ice_servers', JSON.stringify(serversArray));
            }
        }
        console.log('[PeerRPC] Active ICE servers updated:', this.iceServers);
    }

    setCustomSignalingUrl(url) {
        this.customSignalingUrl = url ? url.trim() : null;
        if (typeof window !== 'undefined' && window.localStorage) {
            if (this.customSignalingUrl) {
                localStorage.setItem('vyz_signaling_url', this.customSignalingUrl);
            } else {
                localStorage.removeItem('vyz_signaling_url');
            }
        }
        // Re-initialize signaling with new endpoint
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this._initSignaling();
    }

    async _fetchIceServers() {
        if (this.loadConfiguredIceServers()) return;

        // Skip fetching server API if hosted on GitHub Pages
        if (PeerRPC.isStaticHosting()) {
            console.log('[PeerRPC] GitHub Pages detected. Defaulting to Google & Cloudflare Public STUN.');
            return;
        }

        try {
            if (typeof window !== 'undefined' && window.location.protocol.startsWith('http')) {
                const res = await fetch('/api/ice-servers');
                if (res.ok) {
                    const data = await res.json();
                    if (data.iceServers && Array.isArray(data.iceServers) && data.iceServers.length > 0) {
                        this.iceServers = data.iceServers;
                    }
                }
            }
        } catch (e) {
            console.log('[PeerRPC] Using public Google & Cloudflare STUN servers');
        }
    }

    _initSignaling() {
        // Priority 1: User-configured signaling URL (useful for GitHub Pages cross-device)
        if (this.customSignalingUrl) {
            this._connectWebSocket(this.customSignalingUrl);
            return;
        }

        // Priority 2: Static Hosting (GitHub Pages) defaults to BroadcastChannel for zero-config multi-tab
        if (PeerRPC.isStaticHosting()) {
            console.log('[PeerRPC] GitHub Pages static hosting. Initialized BroadcastChannel signaling.');
            this._initBroadcastFallback();
            if (this.onConnectionStatus) this.onConnectionStatus('github-pages-broadcast');
            return;
        }

        // Priority 3: Local Node / Express WebSocket Server (/ws)
        if (typeof window !== 'undefined' && window.location.protocol.startsWith('http')) {
            const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = `${proto}//${window.location.host}/ws`;
            this._connectWebSocket(wsUrl);
        } else {
            this._initBroadcastFallback();
        }
    }

    _connectWebSocket(wsUrl) {
        try {
            console.log(`[PeerRPC] Connecting to WebSocket signaling at: ${wsUrl}`);
            this.ws = new WebSocket(wsUrl);

            this.ws.onopen = () => {
                console.log('[PeerRPC] WebSocket signaling connected');
                if (this.onConnectionStatus) this.onConnectionStatus('connected');
                this._announcePresence();
            };

            this.ws.onmessage = (evt) => {
                try {
                    const msg = JSON.parse(evt.data);
                    this._handleSignalMessage(msg);
                } catch (err) {
                    console.error('[PeerRPC] Signal parse error:', err);
                }
            };

            this.ws.onerror = () => {
                console.warn('[PeerRPC] WebSocket error, fallback to BroadcastChannel');
                this._initBroadcastFallback();
            };

            this.ws.onclose = () => {
                console.log('[PeerRPC] WebSocket closed, fallback to BroadcastChannel');
                this._initBroadcastFallback();
            };
        } catch (e) {
            this._initBroadcastFallback();
        }
    }

    _initBroadcastFallback() {
        if (typeof window !== 'undefined' && window.BroadcastChannel && !this.broadcastChannel) {
            this.broadcastChannel = new BroadcastChannel(`vyz-room-${this.roomId}`);
            this.broadcastChannel.onmessage = (evt) => {
                const msg = evt.data;
                if (msg.fromPeerId !== this.peerId) {
                    this._handleSignalMessage(msg);
                }
            };
            console.log('[PeerRPC] BroadcastChannel signaling active for room:', this.roomId);
            this._announcePresence();
        }
    }

    _announcePresence() {
        this._sendSignal({
            type: 'PEER_ANNOUNCE',
            peerId: this.peerId,
            role: this.role,
            name: this.userName,
            isBroadcasting: this.isBroadcastingMerged
        });

        // Re-announce any local sources already registered
        this.localSources.forEach((entry, sourceId) => {
            this._sendSignal({
                type: 'SOURCE_ANNOUNCE',
                sourceId: sourceId,
                streamId: entry.stream.id,
                metadata: entry.metadata
            });
        });
    }

    _sendSignal(msg) {
        msg.fromPeerId = this.peerId;
        msg.roomId = this.roomId;

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg));
        } else if (this.broadcastChannel) {
            this.broadcastChannel.postMessage(msg);
        }
    }

    _initDataBusBridge() {
        if (!this.dataBus) return;

        this.dataBus.setNetworkSync((topic, data) => {
            let sentViaDataChannel = false;
            const payload = JSON.stringify({ type: 'DATA_BUS_SYNC', topic, data });

            this.dataChannels.forEach((dc) => {
                if (dc.readyState === 'open') {
                    dc.send(payload);
                    sentViaDataChannel = true;
                }
            });

            if (!sentViaDataChannel) {
                this._sendSignal({
                    type: 'DATA_BUS_SYNC',
                    topic: topic,
                    payload: data
                });
            }
        });
    }

    _getOrCreatePeerConnection(targetPeerId) {
        if (this.rtcPeers.has(targetPeerId)) {
            return this.rtcPeers.get(targetPeerId);
        }

        console.log(`[PeerRPC] Creating RTCPeerConnection for ${targetPeerId} using ICE servers:`, this.iceServers);
        const pc = new RTCPeerConnection({
            iceServers: this.iceServers,
            iceCandidatePoolSize: 10
        });

        this.rtcPeers.set(targetPeerId, pc);
        this.makingOffer.set(targetPeerId, false);
        this.ignoreOffer.set(targetPeerId, false);
        this.candidateQueues.set(targetPeerId, []);

        pc.onicecandidate = (evt) => {
            if (evt.candidate) {
                this._sendSignal({
                    type: 'ICE_CANDIDATE',
                    targetPeerId: targetPeerId,
                    candidate: evt.candidate
                });
            }
        };

        pc.oniceconnectionstatechange = () => {
            console.log(`[PeerRPC] ICE State (${targetPeerId}):`, pc.iceConnectionState);
            if (pc.iceConnectionState === 'failed') {
                pc.restartIce();
            } else if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'closed') {
                this._handlePeerDisconnected(targetPeerId);
            }
        };

        // Incoming track handler
        pc.ontrack = (evt) => {
            console.log(`[PeerRPC] Received remote track (${evt.track.kind}) from ${targetPeerId}`);
            let stream = evt.streams[0];
            if (!stream) {
                stream = new MediaStream([evt.track]);
            }

            const streamId = stream.id;
            this.remoteStreams.set(streamId, stream);

            const meta = this.peerMetadata.get(targetPeerId) || { name: 'Remote Participant', role: 'participant' };
            const isMerged = meta.isBroadcasting && (streamId.includes('merged') || meta.role === 'host');

            if (this.onRemoteStreamReceived) {
                this.onRemoteStreamReceived(targetPeerId, stream, {
                    ...meta,
                    streamId: streamId,
                    isMergedBroadcast: isMerged
                });
            }
        };

        // DataChannel setup
        if (this.role === 'host') {
            const dc = pc.createDataChannel('vyz-control', { ordered: true });
            this._setupDataChannel(targetPeerId, dc);
        } else {
            pc.ondatachannel = (evt) => {
                this._setupDataChannel(targetPeerId, evt.channel);
            };
        }

        // Attach existing local sources to this peer connection
        this._attachAllLocalSourcesToPeer(pc);

        // Perfect Negotiation
        pc.onnegotiationneeded = async () => {
            try {
                this.makingOffer.set(targetPeerId, true);
                await pc.setLocalDescription();
                this._sendSignal({
                    type: 'SDP_DESCRIPTION',
                    targetPeerId: targetPeerId,
                    description: pc.localDescription
                });
            } catch (err) {
                console.error(`[PeerRPC] Negotiation error for ${targetPeerId}:`, err);
            } finally {
                this.makingOffer.set(targetPeerId, false);
            }
        };

        return pc;
    }

    _attachAllLocalSourcesToPeer(pc) {
        // Attach individual local media sources
        this.localSources.forEach(({ stream }) => {
            stream.getTracks().forEach(track => {
                const senders = pc.getSenders();
                const existing = senders.find(s => s.track && s.track.id === track.id);
                if (!existing) {
                    pc.addTrack(track, stream);
                }
            });
        });

        // If Host is broadcasting merged stream, attach its tracks
        if (this.isBroadcastingMerged && this.mergedBroadcastStream) {
            this.mergedBroadcastStream.getTracks().forEach(track => {
                const senders = pc.getSenders();
                const existing = senders.find(s => s.track && s.track.id === track.id);
                if (!existing) {
                    pc.addTrack(track, this.mergedBroadcastStream);
                }
            });
        }
    }

    _setupDataChannel(peerId, dc) {
        this.dataChannels.set(peerId, dc);

        dc.onopen = () => {
            console.log(`[PeerRPC] DataChannel open with ${peerId}`);
        };

        dc.onmessage = (evt) => {
            try {
                const msg = JSON.parse(evt.data);
                if (msg.type === 'DATA_BUS_SYNC' && this.dataBus) {
                    this.dataBus.ingestRemoteSync(msg.topic, msg.data);
                } else if (msg.type === 'RPC_TOGGLE_FEED' && this.onRemoteToggleReceived) {
                    this.onRemoteToggleReceived(msg);
                } else if (msg.type === 'RPC_TRACK_TOGGLE' && this.onTrackToggleReceived) {
                    this.onTrackToggleReceived(msg);
                }
            } catch (e) {
                console.warn('[PeerRPC] DataChannel message parse error:', e);
            }
        };

        dc.onclose = () => {
            this.dataChannels.delete(peerId);
        };
    }

    async _handleSignalMessage(msg) {
        const fromPeer = msg.fromPeerId;

        switch (msg.type) {
            case 'PEER_ANNOUNCE':
                if (fromPeer && fromPeer !== this.peerId) {
                    this.connectedPeers.add(fromPeer);
                    this.peerMetadata.set(fromPeer, {
                        name: msg.name || 'Peer',
                        role: msg.role,
                        isBroadcasting: !!msg.isBroadcasting
                    });

                    if (this.onPeerListChanged) {
                        this.onPeerListChanged(Array.from(this.connectedPeers).map(id => ({
                            id,
                            ...(this.peerMetadata.get(id) || {})
                        })));
                    }

                    if (this.role === 'host') {
                        this._getOrCreatePeerConnection(fromPeer);
                    }
                }
                break;

            case 'SOURCE_ANNOUNCE':
                if (fromPeer && fromPeer !== this.peerId) {
                    console.log(`[PeerRPC] Peer ${fromPeer} announced source ${msg.sourceId}`);
                }
                break;

            case 'SDP_DESCRIPTION':
                if (msg.targetPeerId === this.peerId) {
                    await this._handleSdpDescription(fromPeer, msg.description);
                }
                break;

            case 'ICE_CANDIDATE':
                if (msg.targetPeerId === this.peerId && msg.candidate) {
                    await this._handleIceCandidate(fromPeer, msg.candidate);
                }
                break;

            case 'RPC_TRACK_TOGGLE':
                if (this.onTrackToggleReceived) {
                    this.onTrackToggleReceived(msg);
                }
                break;

            case 'RPC_TOGGLE_FEED':
                if (this.onRemoteToggleReceived) {
                    this.onRemoteToggleReceived(msg);
                }
                break;

            case 'BROADCAST_STATUS':
                if (this.onBroadcastStatusReceived) {
                    this.onBroadcastStatusReceived({
                        peerId: fromPeer,
                        active: msg.active
                    });
                }
                break;

            case 'PEER_LEFT':
                this._handlePeerDisconnected(fromPeer);
                break;
        }
    }

    async _handleSdpDescription(fromPeer, description) {
        const pc = this._getOrCreatePeerConnection(fromPeer);
        const readyForOffer = !this.makingOffer.get(fromPeer) &&
            (pc.signalingState === 'stable' || pc.signalingState === 'have-local-offer');
        const offerCollision = description.type === 'offer' && !readyForOffer;

        this.ignoreOffer.set(fromPeer, !this.polite && offerCollision);
        if (this.ignoreOffer.get(fromPeer)) {
            console.warn(`[PeerRPC] Glare detected, impolite peer ignoring offer from ${fromPeer}`);
            return;
        }

        try {
            await pc.setRemoteDescription(new RTCSessionDescription(description));

            const queue = this.candidateQueues.get(fromPeer) || [];
            while (queue.length > 0) {
                const candidate = queue.shift();
                await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => console.warn(e));
            }

            if (description.type === 'offer') {
                await pc.setLocalDescription();
                this._sendSignal({
                    type: 'SDP_DESCRIPTION',
                    targetPeerId: fromPeer,
                    description: pc.localDescription
                });
            }
        } catch (err) {
            console.error(`[PeerRPC] Error handling SDP from ${fromPeer}:`, err);
        }
    }

    async _handleIceCandidate(fromPeer, candidate) {
        const pc = this._getOrCreatePeerConnection(fromPeer);
        if (pc.remoteDescription && pc.remoteDescription.type) {
            try {
                await pc.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (err) {
                if (!this.ignoreOffer.get(fromPeer)) {
                    console.warn(`[PeerRPC] ICE candidate error from ${fromPeer}:`, err);
                }
            }
        } else {
            if (!this.candidateQueues.has(fromPeer)) {
                this.candidateQueues.set(fromPeer, []);
            }
            this.candidateQueues.get(fromPeer).push(candidate);
        }
    }

    _handlePeerDisconnected(peerId) {
        console.log(`[PeerRPC] Peer disconnected: ${peerId}`);
        this.connectedPeers.delete(peerId);
        this.peerMetadata.delete(peerId);

        if (this.rtcPeers.has(peerId)) {
            const pc = this.rtcPeers.get(peerId);
            pc.close();
            this.rtcPeers.delete(peerId);
        }
        this.dataChannels.delete(peerId);

        if (this.onRemoteStreamRemoved) {
            this.onRemoteStreamRemoved(peerId);
        }

        if (this.onPeerListChanged) {
            this.onPeerListChanged(Array.from(this.connectedPeers).map(id => ({
                id,
                ...(this.peerMetadata.get(id) || {})
            })));
        }
    }

    registerLocalSource(sourceId, stream, metadata = {}) {
        this.localSources.set(sourceId, { stream, metadata });

        this.rtcPeers.forEach((pc) => {
            const senders = pc.getSenders();
            stream.getTracks().forEach(track => {
                const existing = senders.find(s => s.track && s.track.id === track.id);
                if (!existing) {
                    pc.addTrack(track, stream);
                }
            });
        });

        this._sendSignal({
            type: 'SOURCE_ANNOUNCE',
            sourceId: sourceId,
            streamId: stream.id,
            metadata: metadata
        });
    }

    unregisterLocalSource(sourceId) {
        const entry = this.localSources.get(sourceId);
        if (entry) {
            const trackIds = entry.stream.getTracks().map(t => t.id);
            this.rtcPeers.forEach((pc) => {
                pc.getSenders().forEach(sender => {
                    if (sender.track && trackIds.includes(sender.track.id)) {
                        pc.removeTrack(sender);
                    }
                });
            });
            this.localSources.delete(sourceId);

            this._sendSignal({
                type: 'SOURCE_REMOVED',
                sourceId: sourceId
            });
        }
    }

    broadcastMergedStream(mergedStream) {
        this.mergedBroadcastStream = mergedStream;
        this.isBroadcastingMerged = !!mergedStream;

        this.rtcPeers.forEach((pc) => {
            if (this.mergedBroadcastStream) {
                this.mergedBroadcastStream.getTracks().forEach(track => {
                    const senders = pc.getSenders();
                    const existing = senders.find(s => s.track && s.track.kind === track.kind);
                    if (existing) {
                        existing.replaceTrack(track);
                    } else {
                        pc.addTrack(track, this.mergedBroadcastStream);
                    }
                });
            }
        });

        this._sendSignal({
            type: 'BROADCAST_STATUS',
            active: this.isBroadcastingMerged
        });
    }

    stopMergedBroadcast() {
        this.isBroadcastingMerged = false;
        this.mergedBroadcastStream = null;

        this._sendSignal({
            type: 'BROADCAST_STATUS',
            active: false
        });
    }

    toggleSourceTrack(targetPeerId, sourceId, trackKind, enabled) {
        const payload = {
            type: 'RPC_TRACK_TOGGLE',
            sourceId: sourceId,
            trackKind: trackKind,
            enabled: enabled,
            byHost: this.role === 'host'
        };

        const dc = this.dataChannels.get(targetPeerId);
        if (dc && dc.readyState === 'open') {
            dc.send(JSON.stringify(payload));
        } else {
            this._sendSignal({
                ...payload,
                targetPeerId: targetPeerId
            });
        }
    }

    destroy() {
        this._sendSignal({ type: 'PEER_LEFT' });
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        if (this.broadcastChannel) {
            this.broadcastChannel.close();
            this.broadcastChannel = null;
        }
        this.rtcPeers.forEach(pc => pc.close());
        this.rtcPeers.clear();
        this.dataChannels.clear();
    }
}

if (typeof window !== 'undefined') {
    window.PeerRPC = PeerRPC;
    window.DEFAULT_PUBLIC_ICE_SERVERS = DEFAULT_PUBLIC_ICE_SERVERS;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PeerRPC, DEFAULT_PUBLIC_ICE_SERVERS };
}
