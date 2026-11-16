/**
 * DynamicCompositor - Multi-Block Real-Time Canvas Rendering & Mixing Engine
 * Dynamically computes layout geometry for arbitrary active MediaBlocks,
 * mixes all active audio tracks through Web Audio API into a master destination,
 * applies master output filter pipelines, and generates the merged broadcast/recording stream.
 */

class DynamicCompositor {
    constructor(canvas, options = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.blocks = []; // Array of MediaBlock instances
        
        this.layout = options.layout || 'grid'; // 'grid' | 'side' | 'stack' | 'pip' | 'solo'
        this.aspectRatio = options.aspectRatio || '16/9';
        this.targetWidth = options.width || 1920;
        this.targetHeight = options.height || 1080;
        this.gap = options.gap || 12;
        this.pipPosition = options.pipPosition || 'bottom-right';
        this.soloBlockId = null;

        // Master Output Post-Processing Filter Pipeline
        this.masterPipeline = new MediaPipeline('master-output', {
            badgeName: 'Studio Program',
            badgeRole: 'Broadcast'
        });

        // Web Audio Master Mixer
        this.audioCtx = null;
        this.audioDestination = null;
        this.connectedSourceNodes = new Map(); // blockId -> { sourceNode, gainNode }

        this.isRunning = false;
        this.rafId = null;

        this.updateCanvasDimensions();
    }

    addBlock(block) {
        if (!this.blocks.includes(block)) {
            this.blocks.push(block);
            this.updateAudioMixer();
        }
    }

    removeBlock(blockId) {
        const index = this.blocks.findIndex(b => b.id === blockId);
        if (index !== -1) {
            this.disconnectBlockAudio(blockId);
            this.blocks.splice(index, 1);
            if (this.soloBlockId === blockId) {
                this.soloBlockId = null;
            }
        }
    }

    setLayout(layout) {
        this.layout = layout;
    }

    setPipPosition(pos) {
        this.pipPosition = pos;
    }

    setSoloBlock(blockId) {
        this.soloBlockId = blockId;
    }

    setAspectRatio(ratioStr) {
        this.aspectRatio = ratioStr;
        this.updateCanvasDimensions();
    }

    updateCanvasDimensions() {
        const parts = this.aspectRatio.split('/');
        const num = parseFloat(parts[0]);
        const den = parseFloat(parts[1]);
        const ratio = num / den;

        if (ratio >= 1) {
            this.targetWidth = 1920;
            this.targetHeight = Math.round(1920 / ratio);
        } else {
            this.targetHeight = 1920;
            this.targetWidth = Math.round(1920 * ratio);
        }

        this.canvas.width = this.targetWidth;
        this.canvas.height = this.targetHeight;
    }

    getActiveBlocks() {
        return this.blocks.filter(b => b.isActive && b.permissionStatus === 'granted');
    }

    /**
     * Compute layout bounding boxes
     */
    computeLayoutSlots(activeBlocks) {
        const w = this.canvas.width;
        const h = this.canvas.height;
        const count = activeBlocks.length;
        const slots = [];

        if (count === 0) return slots;

        // Solo Mode
        if (this.layout === 'solo' || count === 1) {
            const target = (this.soloBlockId && activeBlocks.find(b => b.id === this.soloBlockId)) || activeBlocks[0];
            slots.push({ x: 0, y: 0, w: w, h: h, block: target });
            return slots;
        }

        // Side-by-Side (Split) Mode
        if (this.layout === 'side') {
            const cellW = (w - this.gap * 3) / 2;
            const cellH = h - this.gap * 2;
            slots.push({ x: this.gap, y: this.gap, w: cellW, h: cellH, block: activeBlocks[0] });
            slots.push({ x: cellW + this.gap * 2, y: this.gap, w: cellW, h: cellH, block: activeBlocks[1] || activeBlocks[0] });
            return slots;
        }

        // Vertical Stack Mode
        if (this.layout === 'stack') {
            const cellW = w - this.gap * 2;
            const cellH = (h - this.gap * 3) / 2;
            slots.push({ x: this.gap, y: this.gap, w: cellW, h: cellH, block: activeBlocks[0] });
            slots.push({ x: this.gap, y: cellH + this.gap * 2, w: cellW, h: cellH, block: activeBlocks[1] || activeBlocks[0] });
            return slots;
        }

        // Picture-in-Picture (PiP) Mode
        if (this.layout === 'pip') {
            slots.push({ x: 0, y: 0, w: w, h: h, block: activeBlocks[0] });

            const pipW = Math.round(w * 0.28);
            const pipH = Math.round(h * 0.28);
            const margin = Math.round(w * 0.025);

            for (let i = 1; i < count; i++) {
                let pipX, pipY;
                if (this.pipPosition === 'bottom-right') {
                    pipX = w - pipW - margin;
                    pipY = h - pipH - margin - ((i - 1) * (pipH + margin));
                } else if (this.pipPosition === 'bottom-left') {
                    pipX = margin;
                    pipY = h - pipH - margin - ((i - 1) * (pipH + margin));
                } else if (this.pipPosition === 'top-left') {
                    pipX = margin;
                    pipY = margin + ((i - 1) * (pipH + margin));
                } else {
                    pipX = w - pipW - margin;
                    pipY = margin + ((i - 1) * (pipH + margin));
                }

                slots.push({ x: pipX, y: pipY, w: pipW, h: pipH, block: activeBlocks[i], isPip: true });
            }
            return slots;
        }

        // Smart Dynamic Grid
        let cols = 1;
        let rows = 1;
        if (count === 2) {
            cols = w >= h ? 2 : 1;
            rows = w >= h ? 1 : 2;
        } else if (count <= 4) {
            cols = 2;
            rows = 2;
        } else if (count <= 6) {
            cols = 3;
            rows = 2;
        } else {
            cols = Math.ceil(Math.sqrt(count));
            rows = Math.ceil(count / cols);
        }

        const cellW = (w - (this.gap * (cols + 1))) / cols;
        const cellH = (h - (this.gap * (rows + 1))) / rows;

        activeBlocks.forEach((block, index) => {
            const col = index % cols;
            const row = Math.floor(index / cols);

            let offsetX = this.gap + col * (cellW + this.gap);
            const isLastRow = row === rows - 1;
            const itemsInLastRow = count - (rows - 1) * cols;
            if (isLastRow && itemsInLastRow < cols) {
                const spareW = (cols - itemsInLastRow) * (cellW + this.gap);
                offsetX += spareW / 2;
            }

            const offsetY = this.gap + row * (cellH + this.gap);

            slots.push({
                x: Math.round(offsetX),
                y: Math.round(offsetY),
                w: Math.round(cellW),
                h: Math.round(cellH),
                block: block
            });
        });

        return slots;
    }

    /**
     * Web Audio Master Mixing Engine
     */
    initAudioMixer() {
        if (!this.audioCtx) {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (AudioCtx) {
                this.audioCtx = new AudioCtx();
                this.audioDestination = this.audioCtx.createMediaStreamDestination();
            }
        }
    }

    updateAudioMixer() {
        this.initAudioMixer();
        if (!this.audioCtx || !this.audioDestination) return;

        if (this.audioCtx.state === 'suspended') {
            this.audioCtx.resume().catch(() => {});
        }

        this.blocks.forEach(block => {
            const hasAudioTrack = block.stream && block.stream.getAudioTracks().length > 0;
            const shouldBeHeard = block.isActive && block.isAudioActive && block.permissionStatus === 'granted';

            let entry = this.connectedSourceNodes.get(block.id);

            if (hasAudioTrack) {
                if (!entry) {
                    try {
                        const sourceNode = this.audioCtx.createMediaStreamSource(block.stream);
                        const gainNode = this.audioCtx.createGain();
                        gainNode.gain.setValueAtTime(shouldBeHeard ? 1.0 : 0.0, this.audioCtx.currentTime);
                        sourceNode.connect(gainNode);
                        gainNode.connect(this.audioDestination);

                        entry = { sourceNode, gainNode };
                        this.connectedSourceNodes.set(block.id, entry);
                    } catch (e) {
                        console.warn(`[DynamicCompositor] Error connecting audio for block ${block.id}:`, e);
                    }
                } else {
                    entry.gainNode.gain.setValueAtTime(shouldBeHeard ? 1.0 : 0.0, this.audioCtx.currentTime);
                }
            } else if (entry) {
                this.disconnectBlockAudio(block.id);
            }
        });
    }

    disconnectBlockAudio(blockId) {
        const entry = this.connectedSourceNodes.get(blockId);
        if (entry) {
            try {
                entry.gainNode.disconnect();
                entry.sourceNode.disconnect();
            } catch (e) {}
            this.connectedSourceNodes.delete(blockId);
        }
    }

    /**
     * Generate the merged broadcast / recording MediaStream
     * Includes canvas video track + mixed audio tracks
     */
    getMergedStream(fps = 60) {
        this.updateAudioMixer();

        const canvasStream = this.canvas.captureStream(fps);
        const audioTracks = (this.audioDestination && this.audioDestination.stream) 
            ? this.audioDestination.stream.getAudioTracks() 
            : [];

        return new MediaStream([
            ...canvasStream.getVideoTracks(),
            ...audioTracks
        ]);
    }

    /**
     * Draw frame
     */
    renderFrame() {
        const w = this.canvas.width;
        const h = this.canvas.height;
        const ctx = this.ctx;

        // Studio Backdrop
        ctx.fillStyle = '#1B3A4B';
        ctx.fillRect(0, 0, w, h);

        const activeBlocks = this.getActiveBlocks();

        if (activeBlocks.length === 0) {
            ctx.save();
            ctx.fillStyle = '#F5F5F0';
            ctx.font = '600 28px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('No Active Media Sources', w / 2, h / 2 - 16);
            ctx.font = '400 18px sans-serif';
            ctx.fillStyle = '#A3B8C2';
            ctx.fillText('Add a Camera, Screen, or Remote Participant to begin broadcasting', w / 2, h / 2 + 24);
            ctx.restore();
            return;
        }

        const slots = this.computeLayoutSlots(activeBlocks);
        slots.sort((a, b) => (a.isPip ? 1 : 0) - (b.isPip ? 1 : 0));

        // Render each block's slot
        slots.forEach(slot => {
            const { x, y, w: sw, h: sh, block, isPip } = slot;
            const media = block.videoElement;

            if (isPip) {
                ctx.save();
                ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
                ctx.shadowBlur = 18;
                ctx.shadowOffsetX = 0;
                ctx.shadowOffsetY = 6;
            }

            if (block.pipeline) {
                block.pipeline.renderTo(ctx, media, x, y, sw, sh, block.fitMode, {
                    isVideoActive: block.isVideoActive,
                    accentColor: block.accentColor,
                    cornerRadius: 10
                });
            } else {
                ctx.drawImage(media, x, y, sw, sh);
            }

            if (isPip) {
                ctx.restore();
            }
        });

        // Apply Master Studio Output Post-Processing Filter (if enabled)
        if (this.masterPipeline) {
            this.masterPipeline.renderMaster(ctx, w, h);
        }
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;

        const loop = () => {
            if (!this.isRunning) return;
            this.renderFrame();
            this.rafId = requestAnimationFrame(loop);
        };

        this.rafId = requestAnimationFrame(loop);
    }

    stop() {
        this.isRunning = false;
        if (this.rafId) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
    }

    destroy() {
        this.stop();
        if (this.audioCtx && this.audioCtx.state !== 'closed') {
            this.audioCtx.close().catch(() => {});
        }
    }
}

if (typeof window !== 'undefined') {
    window.DynamicCompositor = DynamicCompositor;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { DynamicCompositor };
}
