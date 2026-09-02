// Shared application service for camera compilation, evaluation, validation,
// and versioned export. UI preview, downloads, and future protocol adapters
// must use this boundary instead of rebuilding scene context independently.
(function (MSE) {
  'use strict';

  const EXPORT_SCHEMA = 'cuttalogue.camera-path';
  const EXPORT_VERSION = 1;

  function findScene(shot, projectState) {
    if (!shot || !shot.sceneId) return null;
    return (projectState.scenes || []).find((scene) => scene.id === shot.sceneId) || null;
  }

  function compileShot(shot, projectState) {
    if (!shot || !Number.isFinite(Number(shot.startSeconds)) || !Number.isFinite(Number(shot.endSeconds))) {
      throw new TypeError('A shot with finite timing is required.');
    }
    const durationSeconds = Math.max(0, Number(shot.endSeconds) - Number(shot.startSeconds));
    const scene = findScene(shot, projectState);
    const initialCamera = MSE.scenes.cameraForScene(scene, shot.preview && shot.preview.initialCameraOverride);
    const targetContext = MSE.scenes.targetsForShot(scene, shot);
    const plan = MSE.cameraPath.compile((shot.direction && shot.direction.camera) || [], {
      durationSeconds,
      initialCamera,
      profile: MSE.scenes.profileForScene(scene),
      targets: targetContext.targets,
      defaultTarget: targetContext.defaultTarget,
    });
    if (shot.sceneId && !scene) plan.warnings.push({ code: 'unresolved_scene', value: shot.sceneId });
    const profileName = (shot.preview && shot.preview.interpreterProfile) || 'cinematic-v1';
    if (profileName !== 'cinematic-v1') plan.warnings.push({ code: 'unsupported_interpreter_profile', value: profileName });
    return plan;
  }

  function evaluateShot(shot, projectState, timeSeconds) {
    return MSE.cameraPath.evaluate(compileShot(shot, projectState), timeSeconds);
  }

  function validateShot(shot, projectState) {
    const plan = compileShot(shot, projectState);
    return { valid: plan.warnings.length === 0, warnings: plan.warnings, plan };
  }

  function exportCamera(shot, projectState) {
    const plan = compileShot(shot, projectState);
    const video = projectState.video || {};
    const numerator = Math.max(1, Math.round(Number(video.fpsNumerator) || 24));
    const denominator = Math.max(1, Math.round(Number(video.fpsDenominator) || 1));
    const fps = numerator / denominator;
    const regularFrameCount = Math.floor(plan.durationSeconds * fps + 1e-9) + 1;
    const times = Array.from({ length: regularFrameCount }, (_, frame) => frame / fps);
    const lastTime = times[times.length - 1] || 0;
    if (plan.durationSeconds - lastTime > 1e-9) times.push(plan.durationSeconds);

    const samples = times.map((timeSeconds, index) => {
      const pose = MSE.cameraPath.evaluate(plan, timeSeconds);
      const isEndpointSample = index >= regularFrameCount;
      return {
        frame: isEndpointSample ? null : index,
        sampleType: isEndpointSample ? 'endpoint' : 'frame',
        timeSeconds,
        position: pose.position,
        rotationQuaternion: pose.rotationQuaternion,
        focalLengthMm: pose.focalLengthMm,
        sourceSegmentIndex: pose.segmentIndex,
      };
    });
    return {
      schema: EXPORT_SCHEMA,
      version: EXPORT_VERSION,
      shotId: shot.id,
      sceneId: shot.sceneId ?? null,
      durationSeconds: plan.durationSeconds,
      frameRate: { numerator, denominator, fps },
      outputFraming: {
        frameRule: video.frameRule || { stride: null, offset: 1 },
      },
      interpreterProfile: (shot.preview && shot.preview.interpreterProfile) || 'cinematic-v1',
      authoritativeSource: 'shot.direction.camera',
      warnings: plan.warnings,
      samples,
    };
  }

  MSE.cameraService = {
    EXPORT_SCHEMA,
    EXPORT_VERSION,
    compileShot,
    evaluateShot,
    validateShot,
    exportCamera,
  };
})(window.MSE = window.MSE || {});
