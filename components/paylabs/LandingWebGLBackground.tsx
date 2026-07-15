"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

const VERTEX_SHADER = `attribute vec2 a; void main(){ gl_Position=vec4(a,0,1); }`;

const FRAGMENT_SHADER = `
                precision mediump float;
                uniform vec2 u_res; uniform float u_t; uniform vec2 u_m;
                void main(){
                    vec2 uv = gl_FragCoord.xy / u_res;
                    vec2 a = vec2(u_res.x/u_res.y, 1.0);
                    vec2 d = (u_m-0.5)*0.06;
                    uv += d*(1.0-length(uv-0.5));
                    float gs = 22.0;
                    vec2 g = uv*a*gs;
                    float b1 = sin(u_t*0.45)*0.5+0.5;
                    float b2 = sin(u_t*0.3+1.2)*0.5+0.5;
                    vec2 f = fract(g), dist = abs(f-0.5);
                    float lt = 0.006 + b1*0.003;
                    float lx = smoothstep(lt, 0.0, dist.x);
                    float ly = smoothstep(lt, 0.0, dist.y);
                    float an = smoothstep(0.05, 0.0, length(dist))*b2;
                    float lat = max(lx,ly)*(0.12+b1*0.08);
                    lat += an*0.2;
                    vec2 dg = (uv+vec2(uv.y,-uv.x)*0.3)*a*gs*0.65;
                    vec2 dd = abs(fract(dg)-0.5);
                    float dl = smoothstep(lt*1.4, 0.0, min(dd.x,dd.y));
                    lat += dl*0.05*b2;
                    vec3 lc = mix(vec3(0.545,0.361,0.965), vec3(1.0,0.416,0.333), b1);
                    vec3 ac = vec3(0.957,0.247,0.369);
                    vec3 c = mix(vec3(0.98,0.98,0.99), lc, lat);
                    c = mix(c, ac, an*0.25);
                    float v = 1.0-length((uv-0.5)*1.15);
                    v = smoothstep(0.0, 0.75, v);
                    c *= v;
                    gl_FragColor = vec4(c, 1.0);
                }
            `;

export default function LandingWebGLBackground() {
  const pathname = usePathname();
  const containerRef = useRef<HTMLDivElement>(null);
  const disabled =
    pathname === "/creator-proof" || pathname.startsWith("/creator-proof/");

  useEffect(() => {
    if (disabled || !containerRef.current) return;

    const container = containerRef.current;
    let canvas: HTMLCanvasElement | null = null;
    let gl: WebGLRenderingContext | null = null;
    let vertexShader: WebGLShader | null = null;
    let fragmentShader: WebGLShader | null = null;
    let program: WebGLProgram | null = null;
    let buffer: WebGLBuffer | null = null;
    let animationFrameId: number | null = null;
    let running = false;
    let disposed = false;
    let mx = 0.5;
    let my = 0.5;
    let targetMx = 0.5;
    let targetMy = 0.5;
    let startedAt = 0;

    let resolutionLocation: WebGLUniformLocation | null = null;
    let timeLocation: WebGLUniformLocation | null = null;
    let mouseLocation: WebGLUniformLocation | null = null;

    function stopAnimation() {
      running = false;
      if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }
    }

    function resize() {
      if (!canvas || !gl) return;
      const dpr = Math.min(window.devicePixelRatio, 2);
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      gl.viewport(0, 0, canvas.width, canvas.height);
    }

    function handleMouseMove(event: MouseEvent) {
      targetMx = event.clientX / window.innerWidth;
      targetMy = 1.0 - event.clientY / window.innerHeight;
    }

    function render() {
      if (
        disposed ||
        !running ||
        !canvas ||
        !gl ||
        !resolutionLocation ||
        !timeLocation ||
        !mouseLocation
      ) {
        return;
      }

      const elapsed = (performance.now() - startedAt) / 1000;
      mx += (targetMx - mx) * 0.04;
      my += (targetMy - my) * 0.04;
      gl.uniform2f(resolutionLocation, canvas.width, canvas.height);
      gl.uniform1f(timeLocation, elapsed);
      gl.uniform2f(mouseLocation, mx, my);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      animationFrameId = requestAnimationFrame(render);
    }

    function startAnimation() {
      if (disposed || running || document.hidden) return;
      running = true;
      render();
    }

    function handleVisibilityChange() {
      if (document.hidden) {
        stopAnimation();
      } else {
        startedAt = performance.now();
        startAnimation();
      }
    }

    function handleContextLost(event: Event) {
      event.preventDefault();
      stopAnimation();
      if (canvas) canvas.style.display = "none";
    }

    function cleanup() {
      if (disposed) return;
      disposed = true;
      stopAnimation();
      window.removeEventListener("resize", resize);
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      canvas?.removeEventListener("webglcontextlost", handleContextLost);

      if (gl) {
        if (buffer) gl.deleteBuffer(buffer);
        if (vertexShader) gl.deleteShader(vertexShader);
        if (fragmentShader) gl.deleteShader(fragmentShader);
        if (program) gl.deleteProgram(program);
      }

      canvas?.remove();
    }

    try {
      canvas = document.createElement("canvas");
      gl = canvas.getContext("webgl", { alpha: true, antialias: false });
      if (!gl) throw new Error("No WebGL");

      canvas.addEventListener("webglcontextlost", handleContextLost);
      container.appendChild(canvas);
      resize();

      function makeShader(source: string, type: number) {
        if (!gl) return null;
        const shader = gl.createShader(type);
        if (!shader) return null;
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
          gl.deleteShader(shader);
          return null;
        }
        return shader;
      }

      vertexShader = makeShader(VERTEX_SHADER, gl.VERTEX_SHADER);
      fragmentShader = makeShader(FRAGMENT_SHADER, gl.FRAGMENT_SHADER);
      if (!vertexShader || !fragmentShader) throw new Error("Shader fail");

      program = gl.createProgram();
      if (!program) throw new Error("Program fail");
      gl.attachShader(program, vertexShader);
      gl.attachShader(program, fragmentShader);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error("Link fail");
      }
      gl.useProgram(program);

      buffer = gl.createBuffer();
      if (!buffer) throw new Error("Buffer fail");
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
        gl.STATIC_DRAW
      );
      const attributeLocation = gl.getAttribLocation(program, "a");
      gl.enableVertexAttribArray(attributeLocation);
      gl.vertexAttribPointer(attributeLocation, 2, gl.FLOAT, false, 0, 0);

      resolutionLocation = gl.getUniformLocation(program, "u_res");
      timeLocation = gl.getUniformLocation(program, "u_t");
      mouseLocation = gl.getUniformLocation(program, "u_m");

      window.addEventListener("resize", resize);
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("visibilitychange", handleVisibilityChange);
      startedAt = performance.now();
      startAnimation();
    } catch (error) {
      console.warn("WebGL fail:", error);
      cleanup();
    }

    return cleanup;
  }, [disabled]);

  if (disabled) return null;

  return <div id="webgl-bg" ref={containerRef} aria-hidden="true" />;
}
