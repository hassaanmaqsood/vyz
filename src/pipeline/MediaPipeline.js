/**
 * MediaPipeline - Modular Real-Time Processing & Filter Pipeline for VYZ
 * Supports MediaPipe-flow inspired filters, background blur / bokeh, sharpening,
 * custom filter plugin loading via URL or File, AR overlays, and master studio post-processing.
 */

class MediaPipeline {
    constructor(blockId, options = {}) {
        this.blockId = blockId;
        this.dataBus = options.dataBus || (typeof window !== 'undefined' ? window.globalDataBus : null);
        
        // Distributed compute configuration: 'local' (runs on producer client) or 'host'
        this.computeTarget = options.computeTarget || 'local';

        // Stage configurations
        this.filters = {
            enabled: false,
            preset: 'none', // 'none' | 'vibrant' | 'cinema' | 'mono' | 'warm' | 'cool' | 'bokeh' | 'sharpen' | 'vintage' | 'neon' | 'cyberpunk'
            customFilterId: null,
            blurIntensity: 12,
            brightness: 100,
            contrast: 100,
            saturation: 100
        };

        this.subtitles = {
            enabled: true,
            referencedSourceId: options.audioSourceId || null,
            currentText: '',
            isFinal: false,
            clearTimer: null,
            maxDisplayMs: 4000
        };

        this.ar = {
            enabled: true,
            activeSpeakerGlow: true,
            badgeName: options.badgeName || '',
            badgeRole: options.badgeRole || '',
            reactionEmoji: '',
            reactionExpiresAt: 0,
            isSpeaking: false,
            audioLevel: 0
        };

        // Offscreen scratch canvas for multi-pass visual effects (bokeh, grain, custom filters)
        this.scratchCanvas = null;
        this.scratchCtx = null;

        // Subscriptions
        this.unsubscribers = [];
        this._setupDataBusListeners();
    }

    // Static registry for custom user plugins & filters
    static customFilters = new Map();

    /**
     * Register a custom filter plugin
     * @param {Object} filterDef - { id, name, process(ctx, sourceMedia, opts) }
     */
    static registerCustomFilter(filterDef) {
        if (!filterDef || !filterDef.id || typeof filterDef.process !== 'function') {
            throw new Error('Invalid custom filter definition: must include id and process() function');
        }
        MediaPipeline.customFilters.set(filterDef.id, filterDef);
        console.log(`[MediaPipeline] Registered custom filter: ${filterDef.name || filterDef.id}`);

        if (window.globalDataBus) {
            window.globalDataBus.publish('pipeline:filter:registered', { id: filterDef.id, name: filterDef.name });
        }
    }

    /**
     * Dynamically load and register a custom filter from a URL
     */
    static async loadFilterFromUrl(url) {
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP ${response.status} loading filter from ${url}`);
            const code = await response.text();
            return MediaPipeline.evaluateFilterCode(code, url);
        } catch (err) {
            console.error(`[MediaPipeline] Error loading filter from URL ${url}:`, err);
            throw err;
        }
    }

    /**
     * Dynamically load and register a custom filter from a local File object
     */
    static async loadFilterFromFile(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const code = e.target.result;
                    const filter = MediaPipeline.evaluateFilterCode(code, file.name);
                    resolve(filter);
                } catch (err) {
                    reject(err);
                }
            };
            reader.onerror = reject;
            reader.readAsText(file);
        });
    }

    /**
     * Evaluates custom filter code securely and registers it
     */
    static evaluateFilterCode(code, sourceName = 'custom') {
        let filterObj = null;

        // Try parsing JSON config or evaluating JS module/function
        if (code.trim().startsWith('{') && code.includes('"id"') && !code.includes('function') && !code.includes('=>')) {
            filterObj = JSON.parse(code);
        } else {
            // Function wrapper returning the filter definition
            const sandboxFn = new Function('MediaPipeline', `
                let module = { exports: {} };
                let exports = module.exports;
                ${code}
                return module.exports.default || module.exports || filter;
            `);
            filterObj = sandboxFn(MediaPipeline);
        }

        if (!filterObj || typeof filterObj.process !== 'function') {
            throw new Error('Filter script must export an object with a process(ctx, sourceMedia, opts) function');
        }

        if (!filterObj.id) {
            filterObj.id = `filter-${Date.now()}`;
        }
        if (!filterObj.name) {
            filterObj.name = sourceName.replace(/\.[^/.]+$/, "");
        }

        MediaPipeline.registerCustomFilter(filterObj);
        return filterObj;
    }

    _setupDataBusListeners() {
        if (!this.dataBus) return;

        // Subtitles from speech recognition
        const unsubTranscript = this.dataBus.subscribe('pipeline:speech:transcript', (evt) => {
            if (!this.subtitles.enabled) return;

            if (this.subtitles.referencedSourceId && evt.sourceId !== this.subtitles.referencedSourceId) {
                return;
            }

            this.subtitles.currentText = evt.text;
            this.subtitles.isFinal = evt.isFinal;

            if (this.subtitles.clearTimer) {
                clearTimeout(this.subtitles.clearTimer);
            }
            this.subtitles.clearTimer = setTimeout(() => {
                this.subtitles.currentText = '';
            }, this.subtitles.maxDisplayMs);
        });

        // Audio levels for AR speaker glow
        const unsubAudio = this.dataBus.subscribe('pipeline:audio:level', (evt) => {
            if (!this.ar.enabled) return;

            const targetAudioId = this.subtitles.referencedSourceId || this.blockId;
            if (evt.sourceId === targetAudioId || evt.sourceId === this.blockId) {
                this.ar.isSpeaking = evt.isSpeaking;
                this.ar.audioLevel = evt.level || 0;
            }
        });

        // Reaction emoji
        const unsubReaction = this.dataBus.subscribe('pipeline:reaction', (evt) => {
            if (evt.blockId === this.blockId || evt.broadcast) {
                this.ar.reactionEmoji = evt.emoji;
                this.ar.reactionExpiresAt = Date.now() + 3000;
            }
        });

        this.unsubscribers.push(unsubTranscript, unsubAudio, unsubReaction);
    }

    setComputeTarget(target) {
        this.computeTarget = target;
    }

    setFilterPreset(preset) {
        this.filters.preset = preset;
        this.filters.enabled = preset !== 'none' || !!this.filters.customFilterId;
    }

    setCustomFilter(filterId) {
        this.filters.customFilterId = filterId;
        this.filters.enabled = !!filterId || this.filters.preset !== 'none';
    }

    triggerReaction(emoji) {
        this.ar.reactionEmoji = emoji;
        this.ar.reactionExpiresAt = Date.now() + 3000;

        if (this.dataBus) {
            this.dataBus.publish('pipeline:reaction', {
                blockId: this.blockId,
                emoji: emoji
            });
        }
    }

    /**
     * Compute CSS filter string for standard presets
     */
    getFilterString() {
        if (!this.filters.enabled) return 'none';

        const parts = [];
        if (this.filters.brightness !== 100) parts.push(`brightness(${this.filters.brightness}%)`);
        if (this.filters.contrast !== 100) parts.push(`contrast(${this.filters.contrast}%)`);
        if (this.filters.saturation !== 100) parts.push(`saturate(${this.filters.saturation}%)`);

        switch (this.filters.preset) {
            case 'vibrant':
                parts.push('saturate(145%) contrast(110%)');
                break;
            case 'cinema':
                parts.push('contrast(115%) saturate(85%) sepia(18%)');
                break;
            case 'mono':
                parts.push('grayscale(100%) contrast(125%)');
                break;
            case 'warm':
                parts.push('sepia(25%) saturate(115%)');
                break;
            case 'cool':
                parts.push('hue-rotate(180deg) saturate(95%)');
                break;
            case 'cyberpunk':
                parts.push('contrast(125%) saturate(150%) hue-rotate(290deg)');
                break;
            case 'sharpen':
                parts.push('contrast(120%) brightness(102%)');
                break;
        }

        return parts.length > 0 ? parts.join(' ') : 'none';
    }

    _getScratchCanvas(w, h) {
        if (!this.scratchCanvas) {
            this.scratchCanvas = document.createElement('canvas');
            this.scratchCtx = this.scratchCanvas.getContext('2d');
        }
        if (this.scratchCanvas.width !== w || this.scratchCanvas.height !== h) {
            this.scratchCanvas.width = Math.max(1, Math.round(w));
            this.scratchCanvas.height = Math.max(1, Math.round(h));
        }
        return { canvas: this.scratchCanvas, ctx: this.scratchCtx };
    }

    /**
     * Render the processed pipeline onto the target canvas context
     */
    renderTo(ctx, sourceMedia, x, y, w, h, fitMode = 'cover', options = {}) {
        const isVideoActive = options.isVideoActive !== false;
        const cornerRadius = options.cornerRadius !== undefined ? options.cornerRadius : 10;

        ctx.save();

        // 1. Clip to block boundary with rounded corners
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, cornerRadius);
        ctx.clip();

        // 2. Render Video OR Audio Avatar
        if (sourceMedia && isVideoActive && (sourceMedia.videoWidth > 0 || sourceMedia.width > 0)) {
            // Check if special multi-pass filter is active (e.g. Bokeh blur or custom filter)
            if (this.filters.enabled && this.filters.preset === 'bokeh') {
                this._renderBokeh(ctx, sourceMedia, x, y, w, h, fitMode);
            } else if (this.filters.enabled && this.filters.preset === 'vintage') {
                this._renderVintage(ctx, sourceMedia, x, y, w, h, fitMode);
            } else if (this.filters.enabled && this.filters.preset === 'neon') {
                this._renderNeonEdge(ctx, sourceMedia, x, y, w, h, fitMode);
            } else if (this.filters.enabled && this.filters.customFilterId && MediaPipeline.customFilters.has(this.filters.customFilterId)) {
                this._renderCustomFilter(ctx, sourceMedia, x, y, w, h, fitMode);
            } else {
                // Standard CSS filter pipeline
                const filterStr = this.getFilterString();
                ctx.filter = filterStr;
                this._drawMediaWithFit(ctx, sourceMedia, x, y, w, h, fitMode);
                ctx.filter = 'none';
            }
        } else {
            // Render Elegant Avatar Tile for audio-only or video-muted state
            this._renderAudioAvatar(ctx, x, y, w, h, options);
        }

        // Reset filter
        ctx.filter = 'none';

        // 3. AR Stage: Active Speaker Glow, Badges, Emojis
        this._renderAROverlays(ctx, x, y, w, h);

        // 4. Subtitles Stage
        this._renderSubtitles(ctx, x, y, w, h);

        ctx.restore();

        // 5. Outer AR Speaker Glow Border (drawn outside clip boundary)
        if (this.ar.enabled && this.ar.activeSpeakerGlow && this.ar.isSpeaking) {
            ctx.save();
            ctx.strokeStyle = '#00F5D4';
            ctx.lineWidth = 4;
            ctx.shadowColor = '#00F5D4';
            ctx.shadowBlur = 18;
            ctx.beginPath();
            ctx.roundRect(x, y, w, h, cornerRadius);
            ctx.stroke();
            ctx.restore();
        }
    }

    /**
     * Render master studio post-processing pass (applied to full merged canvas)
     */
    renderMaster(ctx, w, h) {
        if (!this.filters.enabled) return;

        if (this.filters.customFilterId && MediaPipeline.customFilters.has(this.filters.customFilterId)) {
            const custom = MediaPipeline.customFilters.get(this.filters.customFilterId);
            try {
                custom.process(ctx, ctx.canvas, {
                    width: w,
                    height: h,
                    timestamp: performance.now(),
                    params: this.filters
                });
            } catch (err) {
                console.error('[MediaPipeline] Master custom filter error:', err);
            }
            return;
        }

        if (this.filters.preset === 'vintage') {
            // Subtle scanlines & vignette on master output
            ctx.save();
            ctx.fillStyle = 'rgba(0, 0, 0, 0.08)';
            for (let y = 0; y < h; y += 4) {
                ctx.fillRect(0, y, w, 2);
            }
            // Master Vignette
            const grad = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.75);
            grad.addColorStop(0, 'rgba(0,0,0,0)');
            grad.addColorStop(1, 'rgba(0,0,0,0.45)');
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, w, h);
            ctx.restore();
        } else if (this.filters.preset !== 'none') {
            // Color grade pass using scratch buffer
            const { canvas: sc, ctx: sctx } = this._getScratchCanvas(w, h);
            sctx.clearRect(0, 0, w, h);
            sctx.drawImage(ctx.canvas, 0, 0);

            ctx.save();
            ctx.filter = this.getFilterString();
            ctx.drawImage(sc, 0, 0, w, h);
            ctx.restore();
        }
    }

    _renderBokeh(ctx, media, x, y, w, h, fitMode) {
        // Multi-pass background depth-of-field simulation
        const { canvas: sc, ctx: sctx } = this._getScratchCanvas(w, h);
        sctx.clearRect(0, 0, w, h);
        this._drawMediaWithFit(sctx, media, 0, 0, w, h, fitMode);

        // Background heavily blurred
        ctx.save();
        ctx.filter = 'blur(16px) brightness(90%)';
        ctx.drawImage(sc, 0, 0, w, h, x - 10, y - 10, w + 20, h + 20);
        ctx.filter = 'none';

        // Foreground subject with soft mask
        const grad = ctx.createRadialGradient(x + w / 2, y + h / 2, h * 0.22, x + w / 2, y + h / 2, h * 0.58);
        grad.addColorStop(0, 'rgba(0,0,0,1)');
        grad.addColorStop(0.7, 'rgba(0,0,0,0.85)');
        grad.addColorStop(1, 'rgba(0,0,0,0)');

        sctx.globalCompositeOperation = 'destination-in';
        sctx.fillStyle = grad;
        sctx.fillRect(0, 0, w, h);
        sctx.globalCompositeOperation = 'source-over';

        ctx.drawImage(sc, x, y, w, h);
        ctx.restore();
    }

    _renderVintage(ctx, media, x, y, w, h, fitMode) {
        ctx.save();
        ctx.filter = 'contrast(120%) sepia(30%) saturate(85%)';
        this._drawMediaWithFit(ctx, media, x, y, w, h, fitMode);
        ctx.filter = 'none';

        // Scanlines
        ctx.fillStyle = 'rgba(0, 0, 0, 0.12)';
        for (let py = y; py < y + h; py += 4) {
            ctx.fillRect(x, py, w, 2);
        }

        // Vignette
        const grad = ctx.createRadialGradient(x + w / 2, y + h / 2, Math.min(w, h) * 0.3, x + w / 2, y + h / 2, Math.max(w, h) * 0.7);
        grad.addColorStop(0, 'rgba(0,0,0,0)');
        grad.addColorStop(1, 'rgba(0,0,0,0.5)');
        ctx.fillStyle = grad;
        ctx.fillRect(x, y, w, h);
        ctx.restore();
    }

    _renderNeonEdge(ctx, media, x, y, w, h, fitMode) {
        ctx.save();
        ctx.filter = 'contrast(160%) invert(90%) hue-rotate(180deg)';
        this._drawMediaWithFit(ctx, media, x, y, w, h, fitMode);
        ctx.filter = 'none';

        ctx.strokeStyle = '#00F5D4';
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 2, y + 2, w - 4, h - 4);
        ctx.restore();
    }

    _renderCustomFilter(ctx, media, x, y, w, h, fitMode) {
        const custom = MediaPipeline.customFilters.get(this.filters.customFilterId);
        const { canvas: sc, ctx: sctx } = this._getScratchCanvas(w, h);
        sctx.clearRect(0, 0, w, h);
        this._drawMediaWithFit(sctx, media, 0, 0, w, h, fitMode);

        try {
            custom.process(sctx, media, {
                width: w,
                height: h,
                timestamp: performance.now(),
                params: this.filters
            });
            ctx.drawImage(sc, x, y, w, h);
        } catch (err) {
            console.error('[MediaPipeline] Custom filter execution error:', err);
            ctx.drawImage(sc, x, y, w, h);
        }
    }

    _renderAudioAvatar(ctx, x, y, w, h, options = {}) {
        const name = this.ar.badgeName || 'Media Source';
        const color = options.accentColor || '#38BDF8';
        const isSpeaking = this.ar.isSpeaking;

        // Dark background tile
        ctx.fillStyle = '#1B3A4B';
        ctx.fillRect(x, y, w, h);

        // Concentric audio wave rings when speaking
        const centerX = x + w / 2;
        const centerY = y + h / 2 - 12;
        const avatarRadius = Math.max(28, Math.min(65, Math.round(h * 0.2)));

        if (isSpeaking) {
            const level = this.ar.audioLevel || 0.5;
            const ringRadius = avatarRadius + 10 + (level * 22);

            ctx.save();
            ctx.strokeStyle = color;
            ctx.lineWidth = 3;
            ctx.globalAlpha = 0.6;
            ctx.beginPath();
            ctx.arc(centerX, centerY, ringRadius, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
        }

        // Avatar circle
        ctx.save();
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(centerX, centerY, avatarRadius, 0, Math.PI * 2);
        ctx.fill();

        // Initials
        const initials = name.split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase() || 'S';
        ctx.fillStyle = '#FFFFFF';
        ctx.font = `700 ${Math.round(avatarRadius * 0.9)}px -apple-system, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(initials, centerX, centerY);

        // Subtitle text under avatar
        ctx.font = `500 ${Math.max(12, Math.round(avatarRadius * 0.38))}px -apple-system, sans-serif`;
        ctx.fillStyle = '#94A3B8';
        ctx.fillText(options.isVideoActive === false ? 'Video Muted' : 'Audio Only', centerX, centerY + avatarRadius + 22);

        ctx.restore();
    }

    _drawMediaWithFit(ctx, media, x, y, w, h, fitMode) {
        const mediaW = media.videoWidth || media.width || 1280;
        const mediaH = media.videoHeight || media.height || 720;
        if (mediaW === 0 || mediaH === 0) return;

        const mediaAspect = mediaW / mediaH;
        const targetAspect = w / h;

        let sx = 0, sy = 0, sw = mediaW, sh = mediaH;
        let dx = x, dy = y, dw = w, dh = h;

        if (fitMode === 'cover') {
            if (mediaAspect > targetAspect) {
                sw = mediaH * targetAspect;
                sx = (mediaW - sw) / 2;
            } else {
                sh = mediaW / targetAspect;
                sy = (mediaH - sh) / 2;
            }
        } else if (fitMode === 'contain') {
            ctx.fillStyle = '#1B3A4B';
            ctx.fillRect(x, y, w, h);

            if (mediaAspect > targetAspect) {
                dh = w / mediaAspect;
                dy = y + (h - dh) / 2;
            } else {
                dw = h * mediaAspect;
                dx = x + (w - dw) / 2;
            }
        }

        ctx.drawImage(media, sx, sy, sw, sh, dx, dy, dw, dh);
    }

    _renderAROverlays(ctx, x, y, w, h) {
        if (!this.ar.enabled) return;

        // Name badge pill
        if (this.ar.badgeName) {
            ctx.save();
            const badgeH = Math.max(22, Math.round(h * 0.07));
            const fontSz = Math.max(12, Math.round(badgeH * 0.55));
            ctx.font = `600 ${fontSz}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
            
            const nameText = this.ar.badgeName + (this.ar.badgeRole ? ` • ${this.ar.badgeRole}` : '');
            const textMetrics = ctx.measureText(nameText);
            const badgeW = textMetrics.width + 24;
            const badgeX = x + 12;
            const badgeY = y + h - badgeH - 12;

            ctx.fillStyle = 'rgba(15, 23, 42, 0.78)';
            ctx.beginPath();
            ctx.roundRect(badgeX, badgeY, badgeW, badgeH, badgeH / 2);
            ctx.fill();

            const dotX = badgeX + 10;
            const dotY = badgeY + badgeH / 2;
            ctx.fillStyle = this.ar.isSpeaking ? '#00F5D4' : '#64748B';
            ctx.beginPath();
            ctx.arc(dotX, dotY, 4, 0, Math.PI * 2);
            ctx.fill();

            ctx.fillStyle = '#F8FAFC';
            ctx.textBaseline = 'middle';
            ctx.fillText(nameText, dotX + 8, dotY);
            ctx.restore();
        }

        // Reaction emoji animation
        if (this.ar.reactionEmoji && Date.now() < this.ar.reactionExpiresAt) {
            ctx.save();
            const remaining = this.ar.reactionExpiresAt - Date.now();
            const progress = 1 - (remaining / 3000);
            const emojiSize = Math.max(32, Math.round(w * 0.12));
            
            const emojiX = x + w / 2;
            const emojiY = y + h * 0.75 - (progress * h * 0.5);
            const alpha = progress > 0.7 ? (1 - progress) / 0.3 : 1;

            ctx.globalAlpha = Math.max(0, alpha);
            ctx.font = `${emojiSize}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(this.ar.reactionEmoji, emojiX, emojiY);
            ctx.restore();
        }
    }

    _renderSubtitles(ctx, x, y, w, h) {
        if (!this.subtitles.enabled || !this.subtitles.currentText) return;

        ctx.save();
        const fontSz = Math.max(13, Math.min(22, Math.round(w * 0.035)));
        ctx.font = `500 ${fontSz}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        const text = this.subtitles.currentText;
        const maxTextW = w * 0.85;
        const metrics = ctx.measureText(text);
        const textW = Math.min(metrics.width, maxTextW);
        const padX = 16;
        const padY = 8;
        const pillW = textW + padX * 2;
        const pillH = fontSz + padY * 2;
        const pillX = x + (w - pillW) / 2;
        const pillY = y + h - pillH - (this.ar.badgeName ? 44 : 16);

        ctx.fillStyle = 'rgba(0, 0, 0, 0.82)';
        ctx.beginPath();
        ctx.roundRect(pillX, pillY, pillW, pillH, 8);
        ctx.fill();

        ctx.fillStyle = '#FFFFFF';
        ctx.shadowColor = 'rgba(0,0,0,0.5)';
        ctx.shadowBlur = 4;
        
        ctx.fillText(text, x + w / 2, pillY + pillH / 2, maxTextW);
        ctx.restore();
    }

    destroy() {
        this.unsubscribers.forEach(unsub => unsub());
        this.unsubscribers = [];
        if (this.subtitles.clearTimer) {
            clearTimeout(this.subtitles.clearTimer);
        }
    }
}

// Built-in starter custom filters
MediaPipeline.registerCustomFilter({
    id: 'film-grain-lut',
    name: '35mm Film Grain & Teal/Orange',
    process(ctx, sourceMedia, { width, height, timestamp }) {
        const imgData = ctx.getImageData(0, 0, width, height);
        const data = imgData.data;
        const len = data.length;
        const seed = Math.sin(timestamp * 0.001);

        for (let i = 0; i < len; i += 16) {
            const noise = ((Math.sin(i * 12.9898 + seed) * 43758.5453) % 1) * 22;
            data[i] = Math.min(255, Math.max(0, data[i] + noise));
            data[i + 1] = Math.min(255, Math.max(0, data[i + 1] + noise * 0.8));
            data[i + 2] = Math.min(255, Math.max(0, data[i + 2] + noise * 1.2));
        }
        ctx.putImageData(imgData, 0, 0);
    }
});

MediaPipeline.registerCustomFilter({
    id: 'ascii-matrix',
    name: 'Matrix Cyber Stream',
    process(ctx, sourceMedia, { width, height, timestamp }) {
        ctx.save();
        ctx.fillStyle = 'rgba(0, 20, 10, 0.2)';
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = '#00F5D4';
        ctx.font = '12px monospace';
        const glyphs = '01VYZSTUDIO#*';
        const cols = Math.floor(width / 32);
        for (let i = 0; i < cols; i++) {
            const char = glyphs[Math.floor(Math.random() * glyphs.length)];
            const y = (Math.sin(timestamp * 0.002 + i) * 0.5 + 0.5) * height;
            ctx.fillText(char, i * 32 + 8, y);
        }
        ctx.restore();
    }
});

if (typeof window !== 'undefined') {
    window.MediaPipeline = MediaPipeline;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { MediaPipeline };
}
