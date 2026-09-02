// Lifecycle-managed WebGL renderer for the native CUTTAlogue camera preview.
// It intentionally owns no project or playback state; callers provide the
// compiled path and current pose. Colors match CUTTAlogue's existing tokens.
(function (MSE) {
  'use strict';

  const VERTEX_SHADER = `
    attribute vec3 position;
    uniform mat4 viewProjection;
    void main() { gl_Position = viewProjection * vec4(position, 1.0); }
  `;
  const FRAGMENT_SHADER = `
    precision mediump float;
    uniform vec4 lineColor;
    void main() { gl_FragColor = lineColor; }
  `;
  const POINT_VERTEX_SHADER = `
    attribute vec3 position;
    attribute vec4 vertexColor;
    uniform mat4 viewProjection;
    uniform float pointScale;
    varying vec4 color;
    void main() {
      gl_Position = viewProjection * vec4(position, 1.0);
      gl_PointSize = max(1.0, pointScale / max(0.01, gl_Position.w));
      color = vertexColor;
    }
  `;
  const POINT_FRAGMENT_SHADER = `
    precision mediump float;
    varying vec4 color;
    void main() {
      vec2 offset = gl_PointCoord - 0.5;
      float distanceSquared = dot(offset, offset);
      if (distanceSquared > 0.25) discard;
      gl_FragColor = vec4(color.rgb, color.a * smoothstep(0.25, 0.08, distanceSquared));
    }
  `;
  const TEXTURE_VERTEX_SHADER = `
    attribute vec3 position;
    attribute vec2 texCoord;
    uniform mat4 viewProjection;
    varying vec2 uv;
    void main() {
      gl_Position = viewProjection * vec4(position, 1.0);
      uv = texCoord;
    }
  `;
  const TEXTURE_FRAGMENT_SHADER = `
    precision mediump float;
    uniform sampler2D imageTexture;
    uniform float opacity;
    varying vec2 uv;
    void main() {
      vec4 pixel = texture2D(imageTexture, uv);
      gl_FragColor = vec4(pixel.rgb, pixel.a * opacity);
    }
  `;

  function createShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`Camera preview shader failed: ${message}`);
    }
    return shader;
  }

  function createProgram(gl, vertexSource = VERTEX_SHADER, fragmentSource = FRAGMENT_SHADER) {
    const program = gl.createProgram();
    const vertex = createShader(gl, gl.VERTEX_SHADER, vertexSource);
    const fragment = createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`Camera preview program failed: ${message}`);
    }
    return program;
  }

  function perspectiveMatrix(fieldOfView, aspect, near, far) {
    const scale = 1 / Math.tan(fieldOfView / 2);
    const range = 1 / (near - far);
    return [
      scale / aspect, 0, 0, 0,
      0, scale, 0, 0,
      0, 0, (far + near) * range, -1,
      0, 0, 2 * far * near * range, 0,
    ];
  }

  function multiplyMatrices(a, b) {
    const result = new Array(16);
    for (let column = 0; column < 4; column += 1) {
      for (let row = 0; row < 4; row += 1) {
        result[column * 4 + row] =
          a[row] * b[column * 4] +
          a[4 + row] * b[column * 4 + 1] +
          a[8 + row] * b[column * 4 + 2] +
          a[12 + row] * b[column * 4 + 3];
      }
    }
    return result;
  }

  function dot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  }

  function viewMatrix(camera) {
    const { forward, right, up } = MSE.cameraPath.cameraBasis(camera);
    const position = camera.position;
    return [
      right[0], up[0], -forward[0], 0,
      right[1], up[1], -forward[1], 0,
      right[2], up[2], -forward[2], 0,
      -dot(right, position), -dot(up, position), dot(forward, position), 1,
    ];
  }

  function fieldOfView(focalLengthMm) {
    return 2 * Math.atan(36 / (2 * Math.max(1, focalLengthMm)));
  }

  function groundGrid(size = 10, step = 1) {
    const vertices = [];
    for (let value = -size; value <= size; value += step) {
      vertices.push(-size, 0, value, size, 0, value);
      vertices.push(value, 0, -size, value, 0, size);
    }
    return vertices;
  }

  const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

  function freeCameraFromOrbit(orbit) {
    const camera = {
      position: [0, 0, 0],
      yaw: orbit.yaw,
      pitch: orbit.pitch,
      roll: 0,
      focalLengthMm: orbit.focalLengthMm,
    };
    const forward = MSE.cameraPath.cameraBasis(camera).forward;
    camera.position = orbit.target.map((value, index) => value - forward[index] * orbit.distance);
    return camera;
  }

  function cameraFrustumVertices(camera, aspect) {
    const basis = MSE.cameraPath.cameraBasis(camera);
    const length = 1.5;
    const halfHeight = length * Math.tan(fieldOfView(camera.focalLengthMm) / 2);
    const halfWidth = halfHeight * aspect;
    const center = camera.position.map((value, index) => value + basis.forward[index] * length);
    const corner = (horizontal, vertical) => center.map((value, index) =>
      value + basis.right[index] * halfWidth * horizontal + basis.up[index] * halfHeight * vertical);
    const corners = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
    const vertices = [];
    corners.forEach((point) => vertices.push(...camera.position, ...point));
    for (let index = 0; index < 4; index += 1) {
      vertices.push(...corners[index], ...corners[(index + 1) % 4]);
    }
    return vertices;
  }

  function moodCardVertices(config, camera) {
    const [x, y, z] = config.position;
    const width = Math.max(0.1, config.width);
    const height = Math.max(0.1, config.height);
    const yaw = config.billboard
      ? Math.atan2(camera.position[0] - x, camera.position[2] - z)
      : config.yawDegrees * Math.PI / 180;
    const cosine = Math.cos(yaw);
    const sine = Math.sin(yaw);
    const point = (horizontal, vertical, u, v) => [
      x + horizontal * cosine,
      y + vertical,
      z - horizontal * sine,
      u,
      v,
    ];
    const left = -width / 2;
    const right = width / 2;
    const bottom = -height / 2;
    const top = height / 2;
    return [
      ...point(left, bottom, 0, 0),
      ...point(right, bottom, 1, 0),
      ...point(right, top, 1, 1),
      ...point(left, bottom, 0, 0),
      ...point(right, top, 1, 1),
      ...point(left, top, 0, 1),
    ];
  }

  class CameraPreviewRenderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.gl = canvas.getContext('webgl', { antialias: true, alpha: false });
      if (!this.gl) throw new Error('WebGL is required for camera preview.');
      this.program = createProgram(this.gl);
      this.positionLocation = this.gl.getAttribLocation(this.program, 'position');
      this.matrixLocation = this.gl.getUniformLocation(this.program, 'viewProjection');
      this.colorLocation = this.gl.getUniformLocation(this.program, 'lineColor');
      this.pointProgram = createProgram(this.gl, POINT_VERTEX_SHADER, POINT_FRAGMENT_SHADER);
      this.pointLocations = {
        position: this.gl.getAttribLocation(this.pointProgram, 'position'),
        color: this.gl.getAttribLocation(this.pointProgram, 'vertexColor'),
        matrix: this.gl.getUniformLocation(this.pointProgram, 'viewProjection'),
        scale: this.gl.getUniformLocation(this.pointProgram, 'pointScale'),
      };
      this.textureProgram = createProgram(this.gl, TEXTURE_VERTEX_SHADER, TEXTURE_FRAGMENT_SHADER);
      this.textureLocations = {
        position: this.gl.getAttribLocation(this.textureProgram, 'position'),
        texCoord: this.gl.getAttribLocation(this.textureProgram, 'texCoord'),
        matrix: this.gl.getUniformLocation(this.textureProgram, 'viewProjection'),
        texture: this.gl.getUniformLocation(this.textureProgram, 'imageTexture'),
        opacity: this.gl.getUniformLocation(this.textureProgram, 'opacity'),
      };
      const gridVertices = groundGrid();
      this.gridBuffer = this.createBuffer(gridVertices);
      this.gridVertexCount = gridVertices.length / 3;
      this.pathBuffer = this.gl.createBuffer();
      this.pathVertexCount = 0;
      this.anchorBuffer = this.gl.createBuffer();
      this.anchorVertexCount = 0;
      this.frustumBuffer = this.gl.createBuffer();
      this.pointCloud = null;
      this.blockoutBuffer = null;
      this.blockoutVertexCount = 0;
      this.moodCardBuffer = this.gl.createBuffer();
      this.moodCardTexture = null;
      this.moodCardSource = null;
      this.moodCardConfig = null;
      this.moodLoadToken = 0;
      this.freeOrbit = {
        target: [0, 1.4, 0],
        yaw: -0.7,
        pitch: -0.35,
        distance: 10,
        focalLengthMm: 45,
      };
      this.disposed = false;
    }

    createBuffer(vertices) {
      const buffer = this.gl.createBuffer();
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buffer);
      this.gl.bufferData(this.gl.ARRAY_BUFFER, new Float32Array(vertices), this.gl.STATIC_DRAW);
      return buffer;
    }

    setPlan(plan) {
      if (this.disposed) return;
      const duration = Number.isFinite(plan.durationSeconds) ? plan.durationSeconds : 0;
      const sampleCount = Math.max(2, Math.min(480, Math.ceil(duration * 24) + 1));
      const vertices = [];
      for (let index = 0; index < sampleCount; index += 1) {
        const time = sampleCount === 1 ? 0 : duration * index / (sampleCount - 1);
        vertices.push(...MSE.cameraPath.evaluate(plan, time).position);
      }
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.pathBuffer);
      this.gl.bufferData(this.gl.ARRAY_BUFFER, new Float32Array(vertices), this.gl.DYNAMIC_DRAW);
      this.pathVertexCount = vertices.length / 3;
    }

    setAnchors(anchors) {
      if (this.disposed) return;
      const vertices = [];
      const radius = 0.15;
      Object.values(anchors || {}).forEach((anchor) => {
        if (!anchor || !Array.isArray(anchor.position) || anchor.position.length !== 3) return;
        const [x, y, z] = anchor.position.map(Number);
        if (![x, y, z].every(Number.isFinite)) return;
        vertices.push(x - radius, y, z, x + radius, y, z);
        vertices.push(x, y - radius, z, x, y + radius, z);
        vertices.push(x, y, z - radius, x, y, z + radius);
      });
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.anchorBuffer);
      this.gl.bufferData(this.gl.ARRAY_BUFFER, new Float32Array(vertices), this.gl.DYNAMIC_DRAW);
      this.anchorVertexCount = vertices.length / 3;
    }

    setMoodCardConfig(config) {
      this.moodCardConfig = config ? {
        ...config,
        position: [...config.position],
      } : null;
    }

    clearMoodCard() {
      this.moodLoadToken += 1;
      if (this.moodCardTexture) this.gl.deleteTexture(this.moodCardTexture);
      this.moodCardTexture = null;
      this.moodCardSource = null;
    }

    async setMoodCardSource(source) {
      if (this.disposed || !source) return null;
      if (this.moodCardSource === source && this.moodCardTexture) return null;
      const token = ++this.moodLoadToken;
      const image = new Image();
      image.decoding = 'async';
      const loaded = new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error('Could not load the environment image for the mood card.'));
      });
      image.src = source;
      await loaded;
      if (this.disposed || token !== this.moodLoadToken) return null;

      if (this.moodCardTexture) this.gl.deleteTexture(this.moodCardTexture);
      const gl = this.gl;
      this.moodCardTexture = gl.createTexture();
      this.moodCardSource = source;
      gl.bindTexture(gl.TEXTURE_2D, this.moodCardTexture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return { aspect: image.naturalWidth / Math.max(1, image.naturalHeight) };
    }

    resetFreeView() {
      this.freeOrbit = { target: [0, 1.4, 0], yaw: -0.7, pitch: -0.35, distance: 10, focalLengthMm: 45 };
    }

    orbitFreeView(deltaX, deltaY) {
      this.freeOrbit.yaw -= deltaX * 0.006;
      this.freeOrbit.pitch = clamp(this.freeOrbit.pitch - deltaY * 0.006, -1.45, 1.45);
    }

    panFreeView(deltaX, deltaY) {
      const camera = freeCameraFromOrbit(this.freeOrbit);
      const { right, up } = MSE.cameraPath.cameraBasis(camera);
      const scale = this.freeOrbit.distance * 0.0015;
      this.freeOrbit.target = this.freeOrbit.target.map((value, index) =>
        value - right[index] * deltaX * scale + up[index] * deltaY * scale);
    }

    zoomFreeView(delta) {
      this.freeOrbit.distance = clamp(this.freeOrbit.distance * Math.exp(delta * 0.001), 0.4, 250);
    }

    clearScene() {
      if (this.pointCloud) {
        this.gl.deleteBuffer(this.pointCloud.positionBuffer);
        this.gl.deleteBuffer(this.pointCloud.colorBuffer);
      }
      if (this.blockoutBuffer) this.gl.deleteBuffer(this.blockoutBuffer);
      this.pointCloud = null;
      this.blockoutBuffer = null;
      this.blockoutVertexCount = 0;
    }

    setSceneGeometry(geometry) {
      if (this.disposed) return;
      this.clearScene();
      if (geometry && geometry.pointCloud) {
        const positions = geometry.pointCloud.positions;
        const colors = geometry.pointCloud.colors;
        const positionBuffer = this.gl.createBuffer();
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, positionBuffer);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, positions, this.gl.STATIC_DRAW);
        const colorBuffer = this.gl.createBuffer();
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, colorBuffer);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, colors, this.gl.STATIC_DRAW);
        const count = positions.length / 3;
        this.pointCloud = { positionBuffer, colorBuffer, count, pointScale: Math.max(12, 850 / Math.sqrt(count)) };
      }
      if (geometry && geometry.blockout && geometry.blockout.length) {
        this.blockoutBuffer = this.gl.createBuffer();
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.blockoutBuffer);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, geometry.blockout, this.gl.STATIC_DRAW);
        this.blockoutVertexCount = geometry.blockout.length / 3;
      }
    }

    resize() {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(this.canvas.clientWidth * ratio));
      const height = Math.max(1, Math.round(this.canvas.clientHeight * ratio));
      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width;
        this.canvas.height = height;
      }
      this.gl.viewport(0, 0, width, height);
    }

    drawBuffer(buffer, vertexCount, color, mode) {
      if (!vertexCount) return;
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buffer);
      this.gl.enableVertexAttribArray(this.positionLocation);
      this.gl.vertexAttribPointer(this.positionLocation, 3, this.gl.FLOAT, false, 0, 0);
      this.gl.uniform4fv(this.colorLocation, color);
      this.gl.drawArrays(mode, 0, vertexCount);
    }

    drawPointCloud(viewProjection) {
      if (!this.pointCloud) return;
      const gl = this.gl;
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.useProgram(this.pointProgram);
      gl.uniformMatrix4fv(this.pointLocations.matrix, false, viewProjection);
      gl.uniform1f(this.pointLocations.scale, this.pointCloud.pointScale);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.pointCloud.positionBuffer);
      gl.enableVertexAttribArray(this.pointLocations.position);
      gl.vertexAttribPointer(this.pointLocations.position, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.pointCloud.colorBuffer);
      gl.enableVertexAttribArray(this.pointLocations.color);
      gl.vertexAttribPointer(this.pointLocations.color, 4, gl.UNSIGNED_BYTE, true, 0, 0);
      gl.drawArrays(gl.POINTS, 0, this.pointCloud.count);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }

    drawMoodCard(viewProjection, camera) {
      const config = this.moodCardConfig;
      if (!config || config.enabled === false || !this.moodCardTexture) return;
      const gl = this.gl;
      const vertices = moodCardVertices(config, camera);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.moodCardBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.DYNAMIC_DRAW);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.useProgram(this.textureProgram);
      gl.uniformMatrix4fv(this.textureLocations.matrix, false, viewProjection);
      gl.uniform1f(this.textureLocations.opacity, clamp(config.opacity, 0.05, 0.8));
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.moodCardTexture);
      gl.uniform1i(this.textureLocations.texture, 0);
      gl.enableVertexAttribArray(this.textureLocations.position);
      gl.vertexAttribPointer(this.textureLocations.position, 3, gl.FLOAT, false, 20, 0);
      gl.enableVertexAttribArray(this.textureLocations.texCoord);
      gl.vertexAttribPointer(this.textureLocations.texCoord, 2, gl.FLOAT, false, 20, 12);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }

    render(pose, viewMode) {
      if (this.disposed) return;
      this.resize();
      const gl = this.gl;
      gl.clearColor(0.078, 0.09, 0.102, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.useProgram(this.program);

      const camera = viewMode === 'free'
        ? freeCameraFromOrbit(this.freeOrbit)
        : pose;
      const aspect = this.canvas.width / Math.max(1, this.canvas.height);
      const projection = perspectiveMatrix(fieldOfView(camera.focalLengthMm), aspect, 0.05, 10000);
      const viewProjection = multiplyMatrices(projection, viewMatrix(camera));
      gl.uniformMatrix4fv(this.matrixLocation, false, viewProjection);
      this.drawBuffer(this.gridBuffer, this.gridVertexCount, [0.173, 0.196, 0.22, 1], gl.LINES);
      this.drawBuffer(this.blockoutBuffer, this.blockoutVertexCount, [0.36, 0.42, 0.47, 0.65], gl.LINES);
      this.drawMoodCard(viewProjection, camera);
      this.drawPointCloud(viewProjection);
      this.gl.useProgram(this.program);
      this.gl.uniformMatrix4fv(this.matrixLocation, false, viewProjection);
      this.drawBuffer(this.anchorBuffer, this.anchorVertexCount, [0.298, 0.553, 1, 1], gl.LINES);
      if (viewMode === 'free') {
        gl.useProgram(this.program);
        gl.uniformMatrix4fv(this.matrixLocation, false, viewProjection);
        gl.disable(gl.DEPTH_TEST);
        this.drawBuffer(this.pathBuffer, this.pathVertexCount, [0.298, 0.553, 1, 1], gl.LINE_STRIP);
        const frustumVertices = cameraFrustumVertices(pose, aspect);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.frustumBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(frustumVertices), gl.DYNAMIC_DRAW);
        this.drawBuffer(this.frustumBuffer, frustumVertices.length / 3, [1, 0.75, 0.2, 1], gl.LINES);
        gl.enable(gl.DEPTH_TEST);
      }
    }

    dispose() {
      if (this.disposed) return;
      this.clearScene();
      this.clearMoodCard();
      this.gl.deleteBuffer(this.gridBuffer);
      this.gl.deleteBuffer(this.pathBuffer);
      this.gl.deleteBuffer(this.anchorBuffer);
      this.gl.deleteBuffer(this.frustumBuffer);
      this.gl.deleteBuffer(this.moodCardBuffer);
      this.gl.deleteProgram(this.program);
      this.gl.deleteProgram(this.pointProgram);
      this.gl.deleteProgram(this.textureProgram);
      this.disposed = true;
    }
  }

  MSE.cameraPreviewRenderer = { CameraPreviewRenderer };
})(window.MSE = window.MSE || {});
