/**
 * MediaBlock - Encapsulates a distinct media source block / card
 * Supports camera, screen share, remote peers, virtual streams, and audio-only mics.
 * Provides independent Audio & Video track toggles (host and source owner controllable),
 * fit-mode management, Web Audio gain & level analysis, and attached pipeline.
 */

class MediaBlock {
    constructor(config = {}) {
        this.id = config.id || `source-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
        this.name = config.name || 'Media Source';
        this.type = config.type || 'camera'; // 'camera' | 'screen' | 'remote' | 'mic' | 'virtual'
        this.role = config.role || 'host';   // 'host' | 'participant'
        this.isRemote = !!config.isRemote;
        this.participantId = config.participantId || 'local-host';

        // Master inclusion toggle
        this.isActive = config.isActive !== undefined ? config.isActive : true;

        // Independent Audio and Video state
        this.hasVideo = false;
        this.hasAudio = false;
        this.isVideoActive = config.isVideoActive !== undefined ? config.isVideoActive : true;
        this.isAudioActive = config.isAudioActive !== undefined ? config.isAudioActive : true;

        // Fit mode: 'cover' (fills cell, may crop) or 'contain' (full frame letterboxed)
        this.fitMode = config.fitMode || (this.type === 'screen' ? 'contain' : 'cover');

        // Permission handshake for remote participants
        this.permissionStatus = this.isRemote ? (config.permissionStatus || 'requested') : 'granted';

        // Color & avatar info for audio-only / video-disabled mode
        const palette = ['#38BDF8', '#818CF8', '#F472B6', '#34D399', '#FBBF24', '#A78BFA'];
        this.accentColor = config.accentColor || palette[Math.abs(this.hashCode(this.id)) % palette.length];

        // Underlying media
        this.stream = null;
        this.videoElement = document.createElement('video');
        this.videoElement.autoplay = true;
        this.videoElement.muted = true; // Muted in DOM to avoid local feedback loop
        this.videoElement.playsInline = true;

        // Pipeline attached to this block
        this.pipeline = new MediaPipeline(this.id, {
            badgeName: this.name,
            badgeRole: this.role === 'host' ? 'Host' : 'Guest',
            audioSourceId: config.audioSourceId || this.id
        });

        // Web Audio analysis and mixing nodes
        this.audioContext = null;
        this.audioAnalyser = null;
        this.audioDataArray = null;
        this.audioSourceNode = null;
        this.gainNode = null;
        this.audioAnalysisLoopId = null;
        this.currentAudioLevel = 0;
        this.isSpeaking = false;

        if (config.stream) {
            this.attachStream(config.stream);
        }
    }

    hashCode(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = (hash << 5) - hash + str.charCodeAt(i);
            hash |= 0;
        }
        return hash;
    }

    /**
     * Attach a MediaStream to this block and detect audio/video tracks
     */
    attachStream(stream) {
        this.stream = stream;

        const vTracks = stream.getVideoTracks();
        const aTracks = stream.getAudioTracks();

        this.hasVideo = vTracks.length > 0;
        this.hasAudio = aTracks.length > 0;

        // Apply initial track enablement states
        if (this.hasVideo) {
            vTracks.forEach(t => { t.enabled = this.isVideoActive; });
            this.videoElement.srcObject = stream;
            this.videoElement.play().catch(() => {});
        }

        if (this.hasAudio) {
            aTracks.forEach(t => { t.enabled = this.isAudioActive; });
            this.startAudioEngine();
        }
    }

    /**
     * Independent Video Toggle (can be called by Host or Source Owner)
     * If video exists, toggles its track and visibility in compositor.
     */
    toggleVideo(forcedState) {
        if (!this.hasVideo && forcedState === undefined) return false;

        this.isVideoActive = forcedState !== undefined ? forcedState : !this.isVideoActive;

        if (this.stream) {
            this.stream.getVideoTracks().forEach(track => {
                track.enabled = this.isVideoActive;
            });
        }

        if (window.globalDataBus) {
            window.globalDataBus.publish('source:state:changed', {
                sourceId: this.id,
                isVideoActive: this.isVideoActive,
                isAudioActive: this.isAudioActive
            });
        }

        return this.isVideoActive;
    }

    /**
     * Independent Audio Toggle (can be called by Host or Source Owner)
     * Mutes/unmutes audio tracks and gain node.
     */
    toggleAudio(forcedState) {
        if (!this.hasAudio && forcedState === undefined) return false;

        this.isAudioActive = forcedState !== undefined ? forcedState : !this.isAudioActive;

        if (this.stream) {
            this.stream.getAudioTracks().forEach(track => {
                track.enabled = this.isAudioActive;
            });
        }

        if (this.gainNode) {
            this.gainNode.gain.setValueAtTime(
                this.isAudioActive ? 1.0 : 0.0,
                this.audioContext ? this.audioContext.currentTime : 0
            );
        }

        if (!this.isAudioActive) {
            this.currentAudioLevel = 0;
            this.isSpeaking = false;
            if (window.globalDataBus) {
                window.globalDataBus.publish('pipeline:audio:level', {
                    sourceId: this.id,
                    participantId: this.participantId,
                    level: 0,
                    isSpeaking: false
                });
            }
        }

        if (window.globalDataBus) {
            window.globalDataBus.publish('source:state:changed', {
                sourceId: this.id,
                isVideoActive: this.isVideoActive,
                isAudioActive: this.isAudioActive
            });
        }

        return this.isAudioActive;
    }

    /**
     * Master block active toggle
     */
    toggle(forcedState) {
        this.isActive = forcedState !== undefined ? forcedState : !this.isActive;
        return this.isActive;
    }

    /**
     * Cycle fit mode between 'cover' and 'contain'
     */
    cycleFitMode() {
        this.fitMode = this.fitMode === 'cover' ? 'contain' : 'cover';
        return this.fitMode;
    }

    /**
     * Returns true if block is ready to render in compositor
     */
    isReady() {
        if (!this.isActive || this.permissionStatus !== 'granted') return false;
        if (!this.stream) return false;

        // If it has video and video is active, check readiness
        if (this.hasVideo && this.isVideoActive) {
            return this.videoElement && this.videoElement.readyState >= 2;
        }

        // If it is audio-only or video-disabled, it is still ready to render as an avatar card
        return this.hasAudio || !this.isVideoActive;
    }

    /**
     * Start Web Audio engine: volume analyser + GainNode
     */
    startAudioEngine() {
        if (!this.stream || this.stream.getAudioTracks().length === 0) return;
        if (this.audioAnalysisLoopId) return;

        try {
            const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtxClass) return;

            this.audioContext = new AudioCtxClass();
            this.audioAnalyser = this.audioContext.createAnalyser();
            this.audioAnalyser.fftSize = 256;
            this.audioAnalyser.smoothingTimeConstant = 0.4;

            this.gainNode = this.audioContext.createGain();
            this.gainNode.gain.setValueAtTime(
                this.isAudioActive ? 1.0 : 0.0,
                this.audioContext.currentTime
            );

            this.audioSourceNode = this.audioContext.createMediaStreamSource(this.stream);
            this.audioSourceNode.connect(this.gainNode);
            this.gainNode.connect(this.audioAnalyser);

            this.audioDataArray = new Uint8Array(this.audioAnalyser.frequencyBinCount);

            const analyze = () => {
                if (!this.audioAnalyser) return;

                if (!this.isAudioActive) {
                    this.currentAudioLevel = 0;
                    this.isSpeaking = false;
                } else {
                    this.audioAnalyser.getByteFrequencyData(this.audioDataArray);
                    let sum = 0;
                    for (let i = 0; i < this.audioDataArray.length; i++) {
                        sum += this.audioDataArray[i];
                    }
                    const avg = sum / this.audioDataArray.length;
                    this.currentAudioLevel = Math.min(1, avg / 75);
                    this.isSpeaking = this.currentAudioLevel > 0.16;
                }

                if (window.globalDataBus) {
                    window.globalDataBus.publish('pipeline:audio:level', {
                        sourceId: this.id,
                        participantId: this.participantId,
                        level: this.currentAudioLevel,
                        isSpeaking: this.isSpeaking
                    });
                }

                this.audioAnalysisLoopId = requestAnimationFrame(analyze);
            };

            this.audioAnalysisLoopId = requestAnimationFrame(analyze);
        } catch (e) {
            console.warn(`[MediaBlock ${this.id}] Audio engine init error:`, e);
        }
    }

    stopAudioEngine() {
        if (this.audioAnalysisLoopId) {
            cancelAnimationFrame(this.audioAnalysisLoopId);
            this.audioAnalysisLoopId = null;
        }
        if (this.audioContext && this.audioContext.state !== 'closed') {
            this.audioContext.close().catch(() => {});
        }
        this.audioContext = null;
        this.audioAnalyser = null;
        this.gainNode = null;
        this.audioSourceNode = null;
    }

    grantPermission() {
        this.permissionStatus = 'granted';
    }

    denyPermission() {
        this.permissionStatus = 'denied';
        this.isActive = false;
    }

    destroy() {
        this.stopAudioEngine();
        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
        }
        if (this.videoElement) {
            this.videoElement.srcObject = null;
        }
        if (this.pipeline) {
            this.pipeline.destroy();
        }
    }
}

if (typeof window !== 'undefined') {
    window.MediaBlock = MediaBlock;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { MediaBlock };
}
