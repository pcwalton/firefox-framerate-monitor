//
// firefox-framerate-monitor/lib/view.js
//
// Copyright (c) 2010 Mozilla Foundation
// Patrick Walton <pcwalton@mozilla.com>
//

// The graph display

function FramerateView(canvas, overlayCanvas) {
    this.canvas = canvas;
    this.overlayCanvas = overlayCanvas;

    this._model = null;

    this.invalid = true;
    this.displayedWidth = canvas.width;

    this._usedWidth = 0;

    let ctx = this.canvas.getContext('2d');
    this._gradient = ctx.createLinearGradient(0, 0, 0, this.canvas.height);
    this._gradient.addColorStop(0.0, "green");
    this._gradient.addColorStop(0.5, "yellow");
    this._gradient.addColorStop(1.0, "red");
}

FramerateView.prototype = {
    _drawSample: function(ctx, sample, x) {
        let { potential, actual } = sample;
        let canvasHeight = this.canvas.height;

        ctx.globalAlpha = 1.0;
        ctx.fillStyle = this._gradient;
        let potentialHeight = Math.min(canvasHeight / 60 *
                                       potential,
                                       canvasHeight);
        let y = canvasHeight - potentialHeight;
        ctx.fillRect(x, y, 1, potentialHeight);

        ctx.globalAlpha = 0.5;
        ctx.fillStyle = "#000000";
        let shadeHeight = Math.max(0,
            Math.min(canvasHeight / 60 * (potential - actual),
                     canvasHeight));
        ctx.fillRect(x, y, 1, shadeHeight);

        ctx.globalAlpha = 1.0;
    },

    // Draws only the newest sample.
    _repaintFast: function() {
        if (!this._model || !this._model.samples)
            return;

        let ctx = this.canvas.getContext('2d');
        let sample = this._model.samples[this._model.samples.length - 1];
        this._drawSample(ctx, sample, this._usedWidth);
        this._usedWidth++;
    },

    _repaintSlow: function() {
        let ctx = this.canvas.getContext('2d');
        let canvasWidth = this.canvas.width, canvasHeight = this.canvas.height;

        // Background
        ctx.fillStyle = "#000000";
        ctx.fillRect(0, 0, canvasWidth, canvasHeight);

        // Samples
        let displayedWidth = this.displayedWidth;
        if (this._model && this._model.samples) {
            let samples = this._model.samples;

            let sampleIndex = samples.length - (displayedWidth - 16);
            sampleIndex = Math.floor(sampleIndex);

            for (let x = 16; x < displayedWidth; x++) {
                if (sampleIndex >= 0 && sampleIndex < samples.length)
                    this._drawSample(ctx, samples[sampleIndex], x);
                sampleIndex++;
            }
        }

        this._usedWidth = displayedWidth;
    },

    _repaintOverlay: function() {
        let ctx = this.overlayCanvas.getContext('2d');
        let { width: canvasWidth, height: canvasHeight } = this.overlayCanvas;

        // Background
        ctx.clearRect(0, 0, canvasWidth, canvasHeight);

        // Horizontal lines
        ctx.fillStyle = "#ffffff";
        for (let i = 0; i < 6; i++) {
            let y = Math.floor(i * canvasHeight / 6);
            ctx.globalAlpha = 0.25;
            ctx.fillRect(0, y, canvasWidth, 1);
            ctx.globalAlpha = 0.5;
            ctx.font = "10px Lucida Grande, Segoe UI, Tahoma, sans-serif";
            ctx.fillText(10 * (6 - i), 3, y + 12);
        }
    },

    _reposition: function() {
        let disp = Math.max(0, this._usedWidth - this.displayedWidth);
        this.canvas.style.MozTransform = "translateX(" + (-disp) + "px)";
    },

    redraw: function() {
        if (this.invalid)
            this._repaintOverlay();

        if (this.invalid || this._usedWidth >= this.canvas.width)
            this._repaintSlow();
        else
            this._repaintFast();

        this._reposition();
        this.invalid = false;
    },

    get model()         { return this._model; },
    set model(newModel) { this._model = newModel; this.invalid = true; }
};

exports.FramerateView = FramerateView;

