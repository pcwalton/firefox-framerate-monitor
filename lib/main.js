//
// Framerate monitor
//
// Copyright (c) 2010 Mozilla Foundation
// Patrick Walton <pcwalton@mozilla.com>
//

let { Cc, Ci, Cu } = require('chrome');
let data = require('self').data;

const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
const MAX_SAMPLES = 2000;

let imports = {};

// The monitoring logic

function Monitor(delegate) {
    this._delegate = delegate;
    this._potentialPaintCount = 0;

    this._onBeforePaint = this._onBeforePaint.bind(this);
}

Monitor.prototype = {
    _onBeforePaint: function() {
        this._potentialPaintCount++;
        this._window.mozRequestAnimationFrame();
    },

    observe: function(subject, topic, data) {
        let paintCount = this._window.mozPaintCount;
        let actual = paintCount - this._prevPaintCount;
        let potential = Math.max(this._potentialPaintCount, actual);

        potential *= 3;
        actual *= 3;

        let samples = this._model.samples;
        samples.push({ potential: potential, actual: actual });
        if (samples.length > MAX_SAMPLES)
            samples.shift();

        if (potential < this._model.least)
            this._model.least = potential;

        this._delegate.modelUpdated();

        this._potentialPaintCount = 0;
        this._prevPaintCount = paintCount;
    },

    startMonitoring: function(windowID, model) {
        this.stopMonitoring();

        let window = this._delegate.window;
        let requestor = window.QueryInterface(Ci.nsIInterfaceRequestor);
        let windowUtils = requestor.getInterface(Ci.nsIDOMWindowUtils);
        this._window = windowUtils.getOuterWindowWithId(windowID);

        this._model = model;

        this._window.addEventListener("MozBeforePaint", this._onBeforePaint,
                                      false);

        this._timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
        this._timer.init(this, 333, Ci.nsITimer.TYPE_REPEATING_PRECISE);

        this._prevPaintCount = this._window.mozPaintCount;

        this._window.mozRequestAnimationFrame();
    },

    stopMonitoring: function() {
        if (this._timer) {
            this._timer.cancel();
            this._timer = null;
        }
        if (this._window) {
            this._window.removeEventListener("MozBeforePaint",
                                             this._onBeforePaint, false);
            this._window = null;
        }
    }
};

// The graph display

function FramerateView(canvas) {
    this.canvas = canvas;
    this.model = null;
}

FramerateView.prototype = {
    redraw: function() {
        let ctx = this.canvas.getContext('2d');
        let canvasWidth = this.canvas.width, canvasHeight = this.canvas.height;

        // Background
        ctx.fillStyle = "#000000";
        ctx.fillRect(0, 0, canvasWidth, canvasHeight);

        // Vertical lines
        ctx.fillStyle = "#404040";
        for (let i = 0; i < canvasWidth; i += 50)
            ctx.fillRect(i, 0, 1, canvasHeight);

        // Samples
        if (this.model && this.model.samples) {
            let samples = this.model.samples;

            let gradient = ctx.createLinearGradient(0, 0, 0, canvasHeight);
            gradient.addColorStop(0.0, "green");
            gradient.addColorStop(0.5, "yellow");
            gradient.addColorStop(1.0, "red");

            let sampleIndex = samples.length - (canvasWidth - 16);
            sampleIndex = Math.floor(sampleIndex);

            let opacity = 0;
            for (let x = 16; x < canvasWidth; x++) {
                if (sampleIndex >= 0 && sampleIndex < samples.length) {
                    let sample = samples[sampleIndex];

                    // Smooth out the graph a little bit
                    let potential, actual;
                    if (sampleIndex > 2) {
                        let lastSample0 = samples[sampleIndex - 2];
                        let lastSample1 = samples[sampleIndex - 1];

                        potential = (sample.potential + lastSample0.potential +
                                    lastSample1.potential) / 3;
                        actual = (sample.actual + lastSample0.actual +
                                 lastSample1.actual) / 3;
                    } else {
                        potential = sample.potential;
                        actual = sample.actual;
                    }

                    ctx.globalAlpha = opacity;
                    ctx.fillStyle = gradient;
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
                }

                sampleIndex++;

                if (opacity < 1)
                    opacity = Math.min(opacity + 0.03, 1.0);
            }
        }

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

        ctx.globalAlpha = 1.0;
    }
};

// The main window

let framerateWindowInstance = null;

function FramerateWindow() {
    let ww = imports.Services.ww;
    this.window = ww.openWindow(null,
                                data.url("main-window.html"),
                                'frameRateMonitor',
                                "resizable,centerscreen,width=480,height=200",
                                null);

    this.window.addEventListener('close', this._onClose.bind(this), null);
    this.window.addEventListener('load', this._onLoad.bind(this), null);

    this.models = {};

    this._monitor = new Monitor(this);

    imports.Services.ww.registerNotification(this);
}

FramerateWindow.prototype = {
    get chromeDocument() { return this.window.document; },
    get canvas() {
        return this.chromeDocument.getElementById('canvas');
    },
    get canvasContainer() {
        return this.chromeDocument.getElementById('canvas-container');
    },
    get clearButton() {
        return this.chromeDocument.getElementById('clear-button');
    },
    get potentialFPSDisplay() {
        return this.chromeDocument.getElementById('potential-fps-display');
    },
    get actualFPSDisplay() {
        return this.chromeDocument.getElementById('actual-fps-display');
    },
    get leastFPSDisplay() {
        return this.chromeDocument.getElementById('least-fps-display');
    },
    get windowSelector() {
        return this.chromeDocument.getElementById('window-selector');
    },

    modelUpdated: function() {
        this.view.redraw();

        let model = this.models[this._windowID];

        let samples = model.samples;
        let lastSample = samples[samples.length - 1];

        this.potentialFPSDisplay.innerHTML =
            "Potential: " + Math.floor(lastSample.potential) + " fps";
        this.actualFPSDisplay.innerHTML =
            "Actual: " + Math.floor(lastSample.actual) + " fps";

        this.leastFPSDisplay.innerHTML = "Min: " + model.least + " fps";
    },

    observe: function(subject, topic, data) {
        switch (topic) {
        case "domwindowopened":
            this._addWindowToWindowList(subject);
            break;
        case "domwindowclosed":
            this._removeWindowFromWindowList(subject);
            break;
        }
    },

    _onChange: function() {
        let index = this.windowSelector.selectedIndex;
        let windowID = this.windowSelector.options[index].windowID;
        this._startMonitoringWindowWithID(windowID);
        this.view.redraw();
    },

    _onClearButtonClick: function() {
        this._initModel(this._windowID);
        this.view.redraw();
    },

    _onClose: function() {
        this._monitor.stopMonitoring();
        imports.Services.ww.unregisterNotification(this);
        framerateWindowInstance = null;
    },

    _onResize: function() {
        this._resizeCanvasToFit();
        this.view.redraw();
    },

    _onLoad: function() {
        this._resizeCanvasToFit();

        this.view = new FramerateView(this.canvas);

        let enumerator = imports.Services.ww.getWindowEnumerator();
        while (enumerator.hasMoreElements()) {
            let unknown = enumerator.getNext();
            let domWindow = unknown.QueryInterface(Ci.nsIDOMWindow);
            this._addWindowToWindowList(domWindow);
        }

        this.windowSelector.addEventListener("change",
                                             this._onChange.bind(this), false);

        this.clearButton.addEventListener("click",
                                          this._onClearButtonClick.bind(this),
                                          false);

        this.window.setTimeout(this._drawInitially.bind(this), 0);
    },

    _addWindowToWindowList: function(domWindow) {
        let option = this.chromeDocument.createElement("option");

        let windowID = this._getWindowIDForWindow(domWindow);

        option.innerHTML = domWindow.document.title + " (#" + windowID + ")";
        option.windowID = windowID;

        if (!this.windowSelector.firstChild)
            this._startMonitoringWindowWithID(windowID);

        this.windowSelector.appendChild(option);
    },

    _drawInitially: function() {
        this.view.redraw();
        this.window.addEventListener('resize', this._onResize.bind(this),
                                     false);
    },

    _getWindowIDForWindow: function(domWindow) {
        let requestor = domWindow.QueryInterface(Ci.nsIInterfaceRequestor);
        let windowUtils = requestor.getInterface(Ci.nsIDOMWindowUtils);
        return windowUtils.outerWindowID;
    },

    _initModel: function(windowID) {
        let model = this.models[windowID];
        model.least = 60;
        model.samples = [];
    },

    _removeWindowFromWindowList: function(domWindow) {
        let windowID = this._getWindowIDForWindow(domWindow);

        let option = this.windowSelector.firstChild;
        while (option) {
            let nextOption = option.nextSibling;
            if (option.windowID == windowID)
                this.windowSelector.removeChild(option);
            option = nextOption;
        }

        if (this._windowID == windowID) {
            this.windowSelector.selectedIndex = 0;
            this._onChange();
        }
    },

    _resizeCanvasToFit: function() {
        let canvas = this.canvas, canvasContainer = this.canvasContainer;
        canvas.width = canvas.height = 1;
        canvas.width = canvasContainer.clientWidth;
        canvas.height = canvasContainer.clientHeight;
    },

    _startMonitoringWindowWithID: function(windowID) {
        if (!('windowID' in this.models)) {
            this.models[windowID] = {};
            this._initModel(windowID);
        }

        this._windowID = windowID;
        this._monitor.startMonitoring(windowID, this.models[windowID]);
        this.view.model = this.models[windowID];
    }
};

function openFramerateMonitor() {
    if (!framerateWindowInstance)
        framerateWindowInstance = new FramerateWindow();
    else
        framerateWindowInstance.focus();
}

// The menu item controller

function MenuItemController() {
    let enumerator = imports.Services.ww.getWindowEnumerator();
    while (enumerator.hasMoreElements()) {
        let domWindow = enumerator.getNext().QueryInterface(Ci.nsIDOMWindow);
        this._createMenuItem(domWindow.document);
    }

    this._onLoad = this._onLoad.bind(this);
    imports.Services.ww.registerNotification(this);
}

MenuItemController.prototype = {
    observe: function(subject, topic, data) {
        if (topic != 'domwindowopened')
            return;

        let domWindow = subject.QueryInterface(Ci.nsIDOMWindow);
        domWindow.addEventListener('load', this._onLoad, false);
    },

    _createMenuItem: function(chromeDocument) {
        let separator = chromeDocument.getElementById("sanitizeSeparator");
        if (!separator)
            return;

        let menuItem = chromeDocument.createElementNS(XUL_NS, "menuitem");
        menuItem.setAttribute("id", "frameRateMonitor");
        menuItem.setAttribute("label", "Frame Rate Monitor");
        menuItem.addEventListener("command", openFramerateMonitor, false);
        separator.parentNode.insertBefore(menuItem, separator);
    },

    _onLoad: function(ev) {
        let chromeDocument = ev.target;
        let domWindow = chromeDocument.defaultView;
        domWindow.removeEventListener('load', this._onLoad, false);
        this._createMenuItem(chromeDocument);
    }
}

// Entry point

exports.main = function() {
    Cu.import("resource://gre/modules/Services.jsm", imports);
    new MenuItemController();
}

