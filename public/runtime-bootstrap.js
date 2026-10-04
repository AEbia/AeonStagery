(function () {
  // Dynamically inserted scripts do not block parsing, even with async=false.
  // Publish their settled result as a Promise so model adapters can await it
  // before evaluating pixi-live2d-display/cubism2.
  var scripts = [
    { file: 'live2d.min.js', key: 'cubism2Loaded', probe: function () { return !!window.Live2D; } },
    { file: 'live2dcubismcore.min.js', key: 'cubismCoreLoaded', probe: function () { return !!(window.Live2DCubismCore && window.Live2DCubismCore.Version); } }
  ];

  var runtimePrefix = window.aeonStageryAPI ? 'aeon-runtime://localhost/' : './';
  var bootstrap = window.__aeonLive2DRuntimeBootstrap = window.__aeonLive2DRuntimeBootstrap || {};
  var resolveReady;
  bootstrap.ready = new Promise(function (resolve) {
    resolveReady = resolve;
  });
  var pending = scripts.length;
  var detail = { cubism2Loaded: false, cubismCoreLoaded: false };
  var dispatched = false;

  function dispatch() {
    if (dispatched) return;
    dispatched = true;
    bootstrap.detail = detail;
    resolveReady(detail);
    try {
      window.dispatchEvent(new CustomEvent('live2d-runtime-bootstrap-complete', { detail: detail }));
    } catch { /* older environments: probes still work via getOfficialCubismSdkStatus */ }
  }

  function settle(script) {
    if (!detail[script.key]) {
      detail[script.key] = script.probe();
    }
    pending -= 1;
    if (pending <= 0) dispatch();
  }

  for (var i = 0; i < scripts.length; i++) {
    (function (script) {
      var el = document.createElement('script');
      el.src = runtimePrefix + script.file;
      el.async = false; // preserve relative order of the two runtime scripts
      el.addEventListener('load', function () { settle(script); });
      el.addEventListener('error', function () { settle(script); });
      // Register listeners before appending so a synchronous failure to
      // resolve the URL still reaches settle().
      (document.head || document.documentElement).appendChild(el);
    })(scripts[i]);
  }
})();
