import * as THREE from 'three';

/**
 * ============================================================================
 *  一人称カメラコントローラ (左ドラッグ視点 + WASDQE)
 * ============================================================================
 * FPS流の視点移動。左クリック押下中のマウス移動で視線(yaw/pitch)、キーで移動する。
 *
 *  操作:
 *    左クリック+移動   視点回転(ドラッグ式。ポインターロックは使わない)
 *    W / A / S / D     カメラローカル基準の前後左右(pitch込みで視線方向へ飛ぶ)
 *    E / Space         上昇 / Q / Ctrl 下降(ワールド垂直)
 *    Left Shift        加速(ダッシュ)
 *
 *  追跡モード:
 *    setFollowTarget() で対象を渡すと、対象を周回する三人称カメラになる。
 *    左ドラッグで周回、ホイールで距離(followDistance)を調整する想定。
 */
export class FirstPersonController {
  private yaw: number;
  private pitch = 0;
  private readonly keys = new Set<string>();
  private dragging = false;

  moveSpeed = 40;
  sprintMultiplier = 4;
  lookSensitivity = 0.0035;

  private forward = new THREE.Vector3();
  private right = new THREE.Vector3();

  private followTarget: THREE.Vector3 | null = null;
  followDistance = 10;

  constructor(
    private camera: THREE.PerspectiveCamera,
    private domElement: HTMLElement,
    startYaw = 0,
    startPitch = 0,
  ) {
    this.yaw = startYaw;
    this.pitch = startPitch;
    this.bindEvents();
    this.applyRotation();
  }

  private bindEvents(): void {
    this.domElement.addEventListener('mousedown', (e) => {
      if (e.button === 0) { this.dragging = true; e.preventDefault(); }
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.dragging = false;
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.dragging) return;
      this.yaw -= e.movementX * this.lookSensitivity;
      this.pitch -= e.movementY * this.lookSensitivity;
      const limit = Math.PI / 2 - 0.01;
      this.pitch = Math.max(-limit, Math.min(limit, this.pitch));
      this.applyRotation();
    });
    this.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => this.keys.add(e.code));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this.dragging = false; });
  }

  private applyRotation(): void {
    const e = new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ');
    this.camera.quaternion.setFromEuler(e);
  }

  setPosition(x: number, y: number, z: number): void {
    this.camera.position.set(x, y, z);
  }

  get isDragging(): boolean { return this.dragging; }

  setFollowTarget(t: THREE.Vector3 | null): void { this.followTarget = t; }
  get isFollowing(): boolean { return this.followTarget !== null; }

  update(dt: number): void {
    // 追跡モード: 対象を yaw/pitch/followDistance で周回するオービットカメラ。
    if (this.followTarget) {
      const t = this.followTarget;
      const d = this.followDistance;
      const cp = Math.cos(this.pitch);
      this.camera.position.set(
        t.x - Math.sin(this.yaw) * cp * d,
        t.y + Math.sin(this.pitch) * d + 1.2,
        t.z - Math.cos(this.yaw) * cp * d,
      );
      this.camera.lookAt(t.x, t.y + 1.0, t.z);
      return;
    }

    // 自由移動モード(カメラローカル基準)
    this.forward.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    this.right.set(1, 0, 0).applyQuaternion(this.camera.quaternion);

    let mx = 0, mz = 0, my = 0;
    if (this.keys.has('KeyW')) mz += 1;
    if (this.keys.has('KeyS')) mz -= 1;
    if (this.keys.has('KeyD')) mx += 1;
    if (this.keys.has('KeyA')) mx -= 1;
    // 上昇: E または Space / 下降: Q または Ctrl(ワールド垂直)
    if (this.keys.has('KeyE') || this.keys.has('Space')) my += 1;
    if (this.keys.has('KeyQ') || this.keys.has('ControlLeft') || this.keys.has('ControlRight')) my -= 1;

    const sprint = this.keys.has('ShiftLeft');
    const speed = this.moveSpeed * (sprint ? this.sprintMultiplier : 1) * dt;

    const pos = this.camera.position;
    pos.addScaledVector(this.forward, mz * speed);
    pos.addScaledVector(this.right, mx * speed);
    pos.y += my * speed;
    if (pos.y < 1.7) pos.y = 1.7;
  }
}
