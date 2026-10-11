/* Mesh-gradient shader for the hero banners (presentation only).
   Without WebGL the CSS gradient on .stage shows instead. */
function bootFx() {
  var FS = 'precision mediump float;uniform vec2 r;uniform float t;' +
    'float b(vec2 p,vec2 c,float s){return exp(-dot(p-c,p-c)/s);}' +
    'void main(){vec2 p=gl_FragCoord.xy/r.y;float a=r.x/r.y;' +
    'vec2 q=p+.06*vec2(sin(p.y*6.+t*.7),cos(p.x*5.-t*.6));' +
    'vec3 col=vec3(.07,.07,.18)' +
    '+vec3(.369,.361,.902)*b(q,vec2(.2*a+.1*sin(t*.3),.75+.1*cos(t*.4)),.12)' +
    '+vec3(1.,.216,.373)*b(q,vec2(.85*a+.1*cos(t*.25),.7+.1*sin(t*.35)),.10)' +
    '+vec3(.039,.518,1.)*b(q,vec2(.5*a+.15*sin(t*.2),.1+.08*cos(t*.3)),.14)' +
    '+vec3(.749,.353,.949)*b(q,vec2(.45*a+.2*cos(t*.33),.5+.1*sin(t*.27)),.06)' +
    '+vec3(1.,.624,.039)*b(q,vec2(.95*a+.05*sin(t*.4),.15),.05)*.8;' +
    'col=col/(1.+col*.35);' +
    'float g=fract(sin(dot(gl_FragCoord.xy,vec2(12.9898,78.233)))*43758.5453);' +
    'gl_FragColor=vec4(col+(g-.5)*.035,1.);}';
  var VS = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
  var still = false; try { still = matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
  var fx = [];
  document.querySelectorAll('canvas.fx').forEach(function (cv) {
    var gl; try { gl = cv.getContext('webgl', { antialias: false }); } catch (e) {}
    if (!gl) return;
    function sh(ty, src) { var s = gl.createShader(ty); gl.shaderSource(s, src); gl.compileShader(s); return s; }
    var pr = gl.createProgram();
    gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) return;
    gl.useProgram(pr);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    fx.push({ cv: cv, gl: gl, ur: gl.getUniformLocation(pr, 'r'), ut: gl.getUniformLocation(pr, 't') });
  });
  if (!fx.length) return;
  var last = 0, t0 = performance.now();
  function draw(now) {
    if (!still && now - last < 33) { requestAnimationFrame(draw); return; }
    last = now;
    var t = still ? 4 : (now - t0) / 1000;
    fx.forEach(function (f) {
      if (!f.cv.offsetParent || document.hidden) return;
      var d = 1, w = Math.max(1, f.cv.clientWidth * d | 0), h = Math.max(1, f.cv.clientHeight * d | 0);
      if (f.cv.width !== w || f.cv.height !== h) { f.cv.width = w; f.cv.height = h; }
      f.gl.viewport(0, 0, w, h); f.gl.uniform2f(f.ur, w, h); f.gl.uniform1f(f.ut, t); f.gl.drawArrays(f.gl.TRIANGLE_STRIP, 0, 4);
    });
    if (!still) requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
  if (still) {
    /* Redraw the still frame when a hidden banner becomes visible. */
    new MutationObserver(function () { requestAnimationFrame(draw); })
      .observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
  }
}
/* Start effects only after the page has loaded and painted. */
(function () {
  function later() { document.documentElement.classList.add('fx-ready'); (window.requestIdleCallback || function (f) { setTimeout(f, 200); })(bootFx, { timeout: 1200 }); }
  function go() { requestAnimationFrame(function () { setTimeout(later, 250); }); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
})();

