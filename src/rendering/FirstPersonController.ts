import * as THREE from 'three';

/**
 * ============================================================================
 *  一人称カメラコントローラ (Pointer Lock + WASD)
 * ============================================================================
 * FPS流の視点移動。マウスで視線(yaw/pitch)、キーで移動する。
 *
 *  操作:
 *    マウス        視点回転(画面クリックでロック開始, Escで解除)
 *    W / A / S / D 前後左右
 *    Space         上昇
 *    Ctrl / C      下降
 *    Shift         加速(ダッシュ)
 *
 * 挙動は毎フレーム update(dt) を呼ぶだけ。シミュレーション本体とは独立。
 * 将来「特定エージェントに憑依する三人称/一人称追従」へ拡張する際も、
 * このクラスの position/quaternion を上書きするだけで差し替えられる。
 */
export class FirstPersonController {
  private yaw: number;
  private pitch = 0;
  private readonly keys = new Set<string>();
  private locked = false;

  /** 基本移動速度 (m/s)。Shiftで sprintMultiplier 倍。 */
  moveSpeed = 40;
  sprintMultiplier = 4;
  /** マウス感度(ラジアン / ピクセル) */
  lookSensitivity = 0.0022;

  private forward = new THREE.Vector3();
  private right = new THREE.Vector3();

  constructor(
    private camera: THREE.PerspectiveCamera,
    private domElement: HTMLElement,
    startYaw = 0,
  ) {
    this.yaw = startYaw;
    this.bindEvents();
    this.applyRotation();
  }

  private bindEvents(): void {
    // クリックでポインターロックを要求
    this.domElement.addEventListener('click', () => {
      if (!this.locked) this.domElement.requestPointerLock();
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.domElement;
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.yaw -= e.movementX * this.lookSensitivity;
      this.pitch -= e.movementY * this.lookSensitivity;
      // 真上・真下でのジンバル反転を防ぐためクランプ
      const limit = Math.PI / 2 - 0.01;
      this.pitch = Math.max(-limit, Math.min(limit, this.pitch));
      this.applyRotation();
    });
    // キー入力(押している間 Set に保持)
    window.addEventListener('keydown', (e) => this.keys.add(e.code));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    // フォーカスを失ったら全キー解放(押しっぱなし暴走の防止)
    window.addEventListener('blur', () => this.keys.clear());
  }

  /** yaw/pitch をカメラのクォータニオンへ反映(順序: yaw→pitch)。 */
  private applyRotation(): void {
    const e = new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ');
    this.camera.quaternion.setFromEuler(e);
  }

  /** カメラの初期位置を設定する。 */
  setPosition(x: number, y: number, z: number): void {
    this.camera.position.set(x, y, z);
  }

  get isLocked(): boolean { return this.locked; }

  /** 毎フレーム呼ぶ。dt は実時間秒。 */
  update(dt: number): void {
    // 視線から水平移動基底を作る(pitchは無視して地面と平行に進む)
    this.forward.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)).multiplyScalar(-1);
    this.right.set(this.forward.z, 0, -this.forward.x); // forwardを-90度回転

    let mx = 0, mz = 0, my = 0;
    if (this.keys.has('KeyW')) mz += 1;
    if (this.keys.has('KeyS')) mz -= 1;
    if (this.keys.has('KeyD')) mx += 1;
    if (this.keys.has('KeyA')) mx -= 1;
    if (this.keys.has('Space')) my += 1;
    if (this.keys.has('ControlLeft') || this.keys.has('KeyC')) my -= 1;

    const sprint = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    const speed = this.moveSpeed * (sprint ? this.sprintMultiplier : 1) * dt;

    const pos = this.camera.position;
    pos.addScaledVector(this.forward, mz * speed);
    pos.addScaledVector(this.right, mx * speed);
    pos.y += my * speed;
    // 地面へめり込まない最低目線高さ
    if (pos.y < 1.7) pos.y = 1.7;
  }
}
