//
// firefox-framerate-monitor/lib/main.js
//
// Copyright (c) 2010 Mozilla Foundation
// Patrick Walton <pcwalton@mozilla.com>
//

let { Cc, Ci, Cu } = require('chrome');
let data = require('self').data;
let FramerateView = require('view').FramerateView;
let Monitor = require('monitor').Monitor;
let Shark = require('shark').Shark;

const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";

let imports = {};

// General utilities

function forEachWindow(callback) {
    let enumerator = imports.Services.ww.getWindowEnumerator();
    while (enumerator.hasMoreElements()) {
        let unknown = enumerator.getNext();
        callback(unknown.QueryInterface(Ci.nsIDOMWindow));
    }
}

// The data model: a set of samples

function Model() {
    this.reset();
}

Model.prototype = {
    reset: function() {
        this.least = 60;
        this.samples = [];
    }
}

// The main window

let framerateWindowInstance = null;

function FramerateWindow() {
    let wm = imports.Services.wm.getMostRecentWindow('navigator:browser');
    this._browserWindow = wm.openDialog("chrome://browser/content/browser.xul",
                                        'frameRateMonitor',
                                        "chrome,close,resizable,menubar," +
                                        "titlebar,width=480,height=200",
                                        data.url("main-window.html"));

    this._browserWindow.addEventListener('DOMContentLoaded',
                                         this._onLoad.bind(this),
                                         null);
    this._browserWindow.addEventListener('close',
                                         this._onClose.bind(this),
                                         null);

    this.playing = true;

    this._models = {};

    try {
        this._shark = new Shark();
        this._autoStopProfiler = false;
    } catch (e) {
        dump("Failed to initialize Shark: " + e + "\n");
        this._shark = null;
    }

    imports.Services.ww.registerNotification(this);

    this._promptService = Cc["@mozilla.org/embedcomp/prompt-service;1"].
                          getService(Ci.nsIPromptService);

    this._profilingGroupShown = false;
}

FramerateWindow.prototype = {
    get chromeDocument() { return this.window.document; },

    focus: function() {
        this.window.focus();
    },

    modelUpdated: function(model) {
        this.view.redraw();

        let samples = model.samples;
        let lastSample = samples[samples.length - 1];

        this.potentialFPSDisplay.innerHTML =
            "Potential: " + Math.floor(lastSample.potential) + " fps";
        this.actualFPSDisplay.innerHTML =
            "Actual: " + Math.floor(lastSample.actual) + " fps";

        if (this._autoStopProfiler) {
            let profilingThreshold = parseInt(this.profilingThreshold.value);
            if (lastSample.potential < profilingThreshold)
                this._stopProfiler();
        }

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
        this._getMonitorForWindowID(this._windowID).stopMonitoring();

        let index = this.windowSelector.selectedIndex;
        let option = this.windowSelector.options[index];
        let windowID = option.getAttribute("windowID");

        this._startMonitoringWindowWithID(windowID);
        this.view.redraw();
    },

    _onClearButtonClick: function() {
        this._getModelForWindowID(this._windowID).reset();
        this.view.redraw();
    },

    _onClose: function() {
        forEachWindow(function(window) {
            if ('_framerateMonitor' in window)
                window._framerateMonitor.stopMonitoring();
        });

        imports.Services.ww.unregisterNotification(this);
        framerateWindowInstance = null;
    },

    _onPauseButtonClick: function() {
        if (this.playing) {
            this._getMonitorForWindowID(this._windowID).stopMonitoring();
            this.pauseButtonImage.setAttribute("src", "play.gif");
        } else {
            this._startMonitoringWindowWithID(this._windowID);
            this.pauseButtonImage.setAttribute("src", "pause.gif");
        }
        this.playing = !this.playing;
    },

    _onResize: function() {
        this._resizeCanvasToFit();
        this.view.redraw();
    },

    _onLoad: function() {
        this.window = this._browserWindow.gBrowser.contentWindow;
        this.chromeDocument.addEventListener('load', this._onLoad.bind(this),
                                             false);

        this.view = new FramerateView(this.canvas, this.overlayCanvas);
        this._resizeCanvasToFit();

        forEachWindow(this._addWindowToWindowList.bind(this));

        this.windowSelector.addEventListener("change",
            this._onChange.bind(this), false);

        this.clearButton.addEventListener("click",
            this._onClearButtonClick.bind(this), false);
        this.pauseButton.addEventListener("click",
            this._onPauseButtonClick.bind(this), false);

        this.profilingHeader.addEventListener("click",
            this._onProfilingHeaderClick.bind(this), false);

        this.autoStopProfilerButton.addEventListener("change",
            this._onAutoStopProfilerChange.bind(this), false);
        this.startSharkButton.addEventListener("click",
            this._onStartSharkButtonClick.bind(this), false);

        if (!this._shark) {
            this.startSharkButton.setAttribute("disabled", "disabled");
            this.profilingGroup.classList.add("disabled");
        }

        this.window.setTimeout(this._drawInitially.bind(this), 0);
    },

    _addWindowToWindowList: function(domWindow) {
        let option = this.chromeDocument.createElement("option");

        let windowID = this._getWindowIDForWindow(domWindow);

        option.innerHTML = domWindow.document.title + " (#" + windowID + ")";
        option.setAttribute("windowID", windowID);

        if (!this.windowSelector.firstChild)
            this._startMonitoringWindowWithID(windowID);

        this.windowSelector.appendChild(option);
    },

    _drawInitially: function() {
        this.view.redraw();
        this.window.addEventListener('resize', this._onResize.bind(this),
                                     false);
    },

    // Returns the model for the given window ID, creating it if necessary.
    _getModelForWindowID: function(windowID) {
        if (!(windowID in this._models))
            this._models[windowID] = new Model();
        return this._models[windowID];
    },

    // Returns the monitor for the given window ID, creating it if necessary.
    _getMonitorForWindowID: function(windowID) {
        let requestor = this.window.QueryInterface(Ci.nsIInterfaceRequestor);
        let windowUtils = requestor.getInterface(Ci.nsIDOMWindowUtils);
        let window = windowUtils.getOuterWindowWithId(windowID);
        window = window.wrappedJSObject;

        if (!('_framerateMonitor' in window)) {
            let model = this._getModelForWindowID(windowID);
            window._framerateMonitor = new Monitor(this, model, window);
        }

        return window._framerateMonitor;
    },

    _getWindowIDForWindow: function(domWindow) {
        let requestor = domWindow.QueryInterface(Ci.nsIInterfaceRequestor);
        let windowUtils = requestor.getInterface(Ci.nsIDOMWindowUtils);
        return windowUtils.outerWindowID;
    },

    _onAutoStopProfilerChange: function() {
        if (this.autoStopProfilerButton.checked) {
            this.profilingThreshold.setAttribute("disabled", "disabled");
            this._autoStopProfiler = true;
        } else {
            this._turnOffAutoStopProfiler();
        }
    },

    _onProfilingHeaderClick: function() {
        if (!this._profilingGroupShown) {
            this.profilingGroup.classList.remove('hidden');
            this.profilingDisclosureImage.setAttribute("src",
                "arrow_expand.gif");
            this._profilingGroupShown = true;
        } else {
            this.profilingGroup.classList.add('hidden');
            this.profilingDisclosureImage.setAttribute("src",
                "arrow_collapse.gif");
            this._profilingGroupShown = false;
        }

        this._resizeCanvasToFit();
    },

    _onStartSharkButtonClick: function() {
        if (!this._profiling) {
            this._startProfiler();
        } else {
            this._stopProfiler();
        }
    },

    _removeWindowFromWindowList: function(domWindow) {
        let windowID = this._getWindowIDForWindow(domWindow);

        let option = this.windowSelector.firstChild;
        while (option) {
            let nextOption = option.nextSibling;
            if (option.getAttribute("windowID") == windowID)
                this.windowSelector.removeChild(option);
            option = nextOption;
        }

        if (this._windowID == windowID) {
            this.windowSelector.selectedIndex = 0;
            this._onChange();
        }
    },

    _resizeCanvasToFit: function() {
        let { canvas, canvasContainer, overlayCanvas } = this;

        canvas.width = canvas.height = 1;
        overlayCanvas.width = overlayCanvas.height = 1;
        let width = canvasContainer.clientWidth;

        canvas.width = width * 3;
        overlayCanvas.width = this.view.displayedWidth = width;
        overlayCanvas.height = canvas.height = canvasContainer.clientHeight;

        this.view.invalid = true;
    },

    _startMonitoringWindowWithID: function(windowID) {
        this._windowID = windowID;

        this.view.model = this._getModelForWindowID(windowID);
        this._getMonitorForWindowID(windowID).startMonitoring();
    },

    _startProfiler: function() {
        if (this._profiling)
            return;

        try {
            this._shark.start();
            this._profiling = true;
            this.startSharkButton.innerHTML = "Stop Profiling";

            this.autoStopProfilerGroup.classList.remove("disabled");
            this.autoStopProfilerButton.removeAttribute("disabled");
            this.profilingThreshold.removeAttribute("disabled");
        } catch (ex) {
            this._promptService.alert(null, "Frame Rate Monitor Error",
                                      "Failed to start Shark: " + ex);
            dump(ex.stack + "\n");
        }
    },

    _stopProfiler: function() {
        if (!this._profiling)
            return;

        try {
            this._shark.stop();
            this._profiling = false;
            this.startSharkButton.innerHTML = "Start Profiling";

            this._turnOffAutoStopProfiler();
            this.autoStopProfilerButton.checked = false;
            this.autoStopProfilerButton.setAttribute("disabled", "disabled");
            this.profilingThreshold.setAttribute("disabled", "disabled");
            this.autoStopProfilerGroup.classList.add("disabled");
        } catch (ex) {
            this._promptService.alert(null, "Frame Rate Monitor Error",
                                      "Failed to stop Shark: " + ex);
            dump(ex.stack + "\n");
        }
    },

    _turnOffAutoStopProfiler: function() {
        if (!this._autoStopProfiler)
            return;
        this.profilingThreshold.removeAttribute("disabled");
        this._autoStopProfiler = false;
    }
};

// Convenience accessors
[
    { name: 'canvas',                   id: "canvas"                        },
    { name: 'overlayCanvas',            id: "overlay-canvas"                },
    { name: 'canvasContainer',          id: "canvas-container"              },
    { name: 'clearButton',              id: "clear-button"                  },
    { name: 'pauseButton',              id: "pause-button"                  },
    { name: 'pauseButtonImage',         id: "pause-button-image"            },
    { name: 'potentialFPSDisplay',      id: "potential-fps-display"         },
    { name: 'autoStopProfilerButton',   id: "auto-stop-profiler-button"     },
    { name: 'autoStopProfilerGroup',    id: "auto-stop-profiler-group"      },
    { name: 'startSharkButton',         id: "start-shark-button"            },
    { name: 'profilingDisclosureImage', id: "profiling-disclosure-image"    },
    { name: 'profilingHeader',          id: "profiling-header"              },
    { name: 'profilingGroup',           id: "profiling-group"               },
    { name: 'profilingThreshold',       id: "profiling-threshold"           },
    { name: 'actualFPSDisplay',         id: "actual-fps-display"            },
    { name: 'leastFPSDisplay',          id: "least-fps-display"             },
    { name: 'windowSelector',           id: "window-selector"               }
].forEach(function(obj) {
    Object.defineProperty(FramerateWindow.prototype, obj.name, {
        get: function() { return this.chromeDocument.getElementById(obj.id); }
    });
});

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

