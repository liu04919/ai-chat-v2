import { ART_HEIGHT, ART_WIDTH, createMesh, VERTEX_STRIDE, type Viewport } from "./geometry";
import { blinkAt, foregroundAt, foregroundPetals, handPetalAt, type Pointer } from "./motion";
import { fragmentShader, spriteFragmentShader, spriteVertexShader, vertexShader } from "./shaders";

// 只负责 GPU 绘制，不持有全局事件或动画循环；生命周期由 controller 统一管理。
export function createRenderer(canvas: HTMLCanvasElement, image: ImageBitmap, repair: ImageBitmap) {
  const context = canvas.getContext("webgl", { alpha: true, antialias: false, premultipliedAlpha: false, powerPreference: "low-power" });
  if (!context) throw new Error("WebGL 不可用");
  const gl = context;
  const programs: WebGLProgram[] = [];
  const buffers: WebGLBuffer[] = [];
  const textures: WebGLTexture[] = [];
  const shaders: WebGLShader[] = [];
  const dispose = () => {
    shaders.forEach(shader => gl.deleteShader(shader));
    programs.forEach(program => gl.deleteProgram(program));
    buffers.forEach(buffer => gl.deleteBuffer(buffer));
    textures.forEach(texture => gl.deleteTexture(texture));
  };

  function compile(type: number, source: string) {
    const shader = gl.createShader(type);
    if (!shader) throw new Error("无法创建着色器");
    shaders.push(shader);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error("着色器编译失败");
    return shader;
  }
  function program(vertex: string, fragment: string) {
    const value = gl.createProgram();
    if (!value) throw new Error("无法创建绘图程序");
    programs.push(value);
    gl.attachShader(value, compile(gl.VERTEX_SHADER, vertex));
    gl.attachShader(value, compile(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(value);
    if (!gl.getProgramParameter(value, gl.LINK_STATUS)) throw new Error("绘图程序链接失败");
    gl.useProgram(value);
    gl.uniform1i(gl.getUniformLocation(value, "uImage"), 0);
    gl.uniform1i(gl.getUniformLocation(value, "uRepair"), 1);
    return value;
  }
  function buffer(target: number, data: Float32Array | Uint16Array) {
    const value = gl.createBuffer();
    if (!value) throw new Error("无法创建顶点缓冲");
    buffers.push(value);
    gl.bindBuffer(target, value);
    gl.bufferData(target, data, gl.STATIC_DRAW);
    return value;
  }
  function uniforms(value: WebGLProgram, names: string[]) {
    return Object.fromEntries(names.map(name => [name, gl.getUniformLocation(value, name)]));
  }

  try {
    const meshProgram = program(vertexShader, fragmentShader);
    const spriteProgram = program(spriteVertexShader, spriteFragmentShader);
    const mesh = createMesh();
    const meshBuffer = buffer(gl.ARRAY_BUFFER, mesh.vertices);
    const indexBuffer = buffer(gl.ELEMENT_ARRAY_BUFFER, mesh.indices);
    const spriteBuffer = buffer(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]));
    const meshAttributes = [
      ["aPosition", 2, 0], ["aRig0", 4, 2], ["aRig1", 4, 6], ["aRig2", 4, 10], ["aTail", 1, 14],
    ].map(([name, size, offset]) => ({ location: gl.getAttribLocation(meshProgram, String(name)), size: Number(size), offset: Number(offset) }));
    const corner = gl.getAttribLocation(spriteProgram, "aCorner");
    const m = uniforms(meshProgram, ["uViewport", "uPointer", "uOffset", "uSample", "uScale", "uTime", "uStrength", "uBlink"]);
    const s = uniforms(spriteProgram, ["uSource", "uPose", "uStretch", "uViewport", "uOrigin", "uScale", "uOpacity"]);
    for (const [unit, source] of [image, repair].entries()) {
      const texture = gl.createTexture();
      if (!texture) throw new Error("无法创建纹理");
      textures.push(texture);
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    }

    function sprite(source: number[], x: number, y: number, size: number, rotation: number, alpha: number, flip = 1, flatten = 1) {
      gl.uniform4fv(s.uSource, source);
      gl.uniform4f(s.uPose, x, y, size, rotation);
      gl.uniform2f(s.uStretch, flip, flatten);
      gl.uniform1f(s.uOpacity, alpha);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    function draw(view: Viewport, time: number, pointer: Pointer) {
      gl.useProgram(meshProgram);
      gl.disable(gl.BLEND);
      gl.bindBuffer(gl.ARRAY_BUFFER, meshBuffer);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
      for (const attribute of meshAttributes) {
        gl.enableVertexAttribArray(attribute.location);
        gl.vertexAttribPointer(attribute.location, attribute.size, gl.FLOAT, false, VERTEX_STRIDE * 4, attribute.offset * 4);
      }
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(m.uViewport, view.width, view.height);
      gl.uniform2f(m.uPointer, pointer.x, pointer.y);
      gl.uniform2f(m.uOffset, view.originX - (view.width - ART_WIDTH * view.scale) / 2, view.originY - (view.height - ART_HEIGHT * view.scale) / 2);
      const sample = view.scale * view.dpr < .8 ? .25 / (view.scale * view.dpr) : 0;
      gl.uniform2f(m.uSample, sample / ART_WIDTH, sample / ART_HEIGHT);
      gl.uniform1f(m.uScale, view.scale);
      gl.uniform1f(m.uTime, time);
      gl.uniform1f(m.uStrength, 1);
      gl.uniform1f(m.uBlink, blinkAt(time));
      gl.drawElements(gl.TRIANGLES, mesh.indices.length, gl.UNSIGNED_SHORT, 0);

      gl.useProgram(spriteProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, spriteBuffer);
      gl.enableVertexAttribArray(corner);
      gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);
      gl.uniform2f(s.uViewport, view.width, view.height);
      gl.uniform2f(s.uOrigin, view.originX, view.originY);
      gl.uniform1f(s.uScale, view.scale);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      for (const petal of foregroundPetals) {
        const p = foregroundAt(petal, time);
        sprite(petal.source, p.x, p.y, 1, p.rotation, .98, .85 + .15 * Math.cos(time * .42 + petal.phase));
      }
      const p = handPetalAt(time, pointer);
      sprite([842, 313, 27, 37], p.x, p.y, p.size, p.rotation, p.alpha, p.flip, p.flatten);
      sprite([728, 53, 20, 15], 728 + Math.sin(time * .38) * 21, 53 + Math.sin(time * .47) * 13, .85, Math.sin(time * .53) * .35, .8);
      sprite([857, 111, 19, 25], 857 + Math.sin(time * .34 + 1) * 14, 111 + Math.sin(time * .39 + 1) * 18, .70, Math.sin(time * .46) * .4, .66);
      gl.disable(gl.BLEND);
    }
    return { draw, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
