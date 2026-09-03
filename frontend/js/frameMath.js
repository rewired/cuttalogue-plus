// FPS / H3 frame math: editorial frames plus the next legal 17n+5 render length.
(function (MSE) {
  'use strict';

  const H3_STRIDE = 17;
  const H3_REMAINDER = 5;
  const H3_FPS = 24;

  function fps(video) {
    return video.fpsNumerator / video.fpsDenominator;
  }

  function desiredFrames(durationSeconds, fpsValue) {
    return Math.max(1, Math.ceil(durationSeconds * fpsValue));
  }

  function renderFramesFor(desired) {
    return desired + (H3_REMAINDER - (desired % H3_STRIDE) + H3_STRIDE) % H3_STRIDE;
  }

  function frameCalc(durationSeconds, video) {
    const fpsValue = fps(video);
    const cutFrames = desiredFrames(durationSeconds, fpsValue);
    const h3DesiredFrames = desiredFrames(durationSeconds, H3_FPS);
    const renderFrames = renderFramesFor(h3DesiredFrames);
    const overhangFrames = renderFrames - h3DesiredFrames;
    const overhangSeconds = Math.max(0, renderFrames / H3_FPS - durationSeconds);
    return { cutFrames, renderFrames, renderFps: H3_FPS, overhangFrames, overhangSeconds };
  }

  MSE.frames = { H3_FPS, H3_STRIDE, H3_REMAINDER, fps, desiredFrames, renderFramesFor, frameCalc };
})(window.MSE = window.MSE || {});
