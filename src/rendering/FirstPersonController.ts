import * as THREE from 'three';

export interface CameraFollowTarget {
  kind: 'agent' | 'vehicle' | 'train';
  id: number;
  position: THREE.Vector3;
  /** Traffic/Railと同じ +X基準のrad。 */
  heading?: number;
  length?: number;
  firstPersonHeight?: number;
  /** target中心から進行方向へ何m前に一人称cameraを置くか。 */
  firstPersonForwardOffset?: number;
}

export class FirstPersonController {
  private yaw: number; private pitch = 0; private readonly keys = new Set<string>(); private dragging = false;
  moveSpeed = 40; sprintMultiplier = 4; lookSensitivity = 0.0035;
  private forward = new THREE.Vector3(); private right = new THREE.Vector3();
  private followTarget: CameraFollowTarget | null = null; followDistance = 10;
  private followYawOffset = 0;
  private followPitch = 0.28;
  private followFirstPerson = false;
  private followKey = '';

  constructor(private camera: THREE.PerspectiveCamera, private domElement: HTMLElement, startYaw = 0, startPitch = 0) {
    this.yaw = startYaw; this.pitch = startPitch; this.bind(); this.applyRotation();
  }

  private bind(): void {
    this.domElement.addEventListener('mousedown', (e) => { if (e.button === 0) { this.dragging = true; e.preventDefault(); } });
    window.addEventListener('mouseup', (e) => { if (e.button === 0) this.dragging = false; });
    document.addEventListener('mousemove', (e) => {
      if (!this.dragging) return;
      if (this.followTarget && this.followFirstPerson) return;
      if (this.followTarget?.kind === 'vehicle' || this.followTarget?.kind === 'train') {
        // heading追従orbitは通常視点と同じドラッグ感にする。
        this.followYawOffset += e.movementX * this.lookSensitivity;
        this.followPitch -= e.movementY * this.lookSensitivity;
        this.followPitch = THREE.MathUtils.clamp(this.followPitch, -0.12, 1.25);
        return;
      }
      this.yaw -= e.movementX * this.lookSensitivity; this.pitch -= e.movementY * this.lookSensitivity;
      const lim = Math.PI / 2 - 0.01; this.pitch = Math.max(-lim, Math.min(lim, this.pitch)); this.applyRotation();
    });
    this.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => this.keys.add(e.code)); window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this.dragging = false; });
  }

  private applyRotation(): void { this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ')); }
  private syncFreeAnglesFromCamera(): void {
    const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ'); this.pitch = e.x; this.yaw = e.y;
  }

  setPosition(x: number, y: number, z: number): void { this.camera.position.set(x, y, z); }
  get isDragging(): boolean { return this.dragging; }

  setFollowTarget(t: CameraFollowTarget | null): void {
    const wasFollowing = this.followTarget !== null;
    const key = t ? `${t.kind}:${t.id}` : '';
    if (t && key !== this.followKey) {
      this.followYawOffset = 0; this.followPitch = 0.28; this.followFirstPerson = false; this.followKey = key;
    }
    if (!t && wasFollowing) { this.followFirstPerson = false; this.followKey = ''; this.syncFreeAnglesFromCamera(); }
    this.followTarget = t;
  }

  get isFollowing(): boolean { return this.followTarget !== null; }
  get isFollowingVehicle(): boolean { return this.followTarget?.kind === 'vehicle'; }
  get isFollowingTrain(): boolean { return this.followTarget?.kind === 'train'; }
  get isFollowingAgent(): boolean { return this.followTarget?.kind === 'agent'; }
  get isFirstPerson(): boolean { return this.isFollowing && this.followFirstPerson; }
  /** 旧HUD/API互換。 */
  get isVehicleFirstPerson(): boolean { return this.isFollowingVehicle && this.followFirstPerson; }

  toggleFollowView(): boolean {
    if (!this.followTarget || this.followTarget.heading == null) return false;
    this.followFirstPerson = !this.followFirstPerson;
    return true;
  }

  /** 旧API互換。現在は人・車・列車すべてを切替可能。 */
  toggleVehicleView(): boolean { return this.toggleFollowView(); }

  update(dt: number): void {
    if (this.followTarget) {
      const t = this.followTarget;
      const h = t.heading ?? 0;
      if (this.followFirstPerson && t.heading != null) {
        const defaultForward = t.kind === 'agent' ? 0.08 : Math.max(0.8, (t.length ?? 4.5) * 0.36);
        const forwardOffset = t.firstPersonForwardOffset ?? defaultForward;
        const defaultHeight = t.kind === 'agent' ? 1.62 : 1.35;
        this.camera.position.set(
          t.position.x + Math.cos(h) * forwardOffset,
          t.position.y + (t.firstPersonHeight ?? defaultHeight),
          t.position.z + Math.sin(h) * forwardOffset,
        );
        // THREEのcamera forward(-Z)をTraffic/Rail heading(+X基準)へ合わせる。
        const cameraYaw = -h - Math.PI / 2;
        this.camera.quaternion.setFromEuler(new THREE.Euler(0, cameraYaw, 0, 'YXZ'));
        return;
      }

      if (t.kind === 'vehicle' || t.kind === 'train') {
        const d = this.followDistance, cp = Math.cos(this.followPitch), orbitHeading = h + this.followYawOffset;
        this.camera.position.set(
          t.position.x - Math.cos(orbitHeading) * cp * d,
          t.position.y + Math.sin(this.followPitch) * d + 1.2,
          t.position.z - Math.sin(orbitHeading) * cp * d,
        );
        this.camera.lookAt(t.position.x, t.position.y + (t.kind === 'train' ? 1.8 : 1.0), t.position.z);
        return;
      }

      const p = t.position, d = this.followDistance, cp = Math.cos(this.pitch);
      this.camera.position.set(p.x - Math.sin(this.yaw) * cp * d, p.y + Math.sin(this.pitch) * d + 1.2, p.z - Math.cos(this.yaw) * cp * d);
      this.camera.lookAt(p.x, p.y + 1.0, p.z); return;
    }

    this.forward.set(0, 0, -1).applyQuaternion(this.camera.quaternion); this.right.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    let mx = 0, mz = 0, my = 0;
    if (this.keys.has('KeyW')) mz += 1; if (this.keys.has('KeyS')) mz -= 1; if (this.keys.has('KeyD')) mx += 1; if (this.keys.has('KeyA')) mx -= 1;
    if (this.keys.has('KeyE') || this.keys.has('Space')) my += 1; if (this.keys.has('KeyQ') || this.keys.has('ControlLeft') || this.keys.has('ControlRight')) my -= 1;
    const sprint = this.keys.has('ShiftLeft'), speed = this.moveSpeed * (sprint ? this.sprintMultiplier : 1) * dt;
    const pos = this.camera.position; pos.addScaledVector(this.forward, mz * speed); pos.addScaledVector(this.right, mx * speed); pos.y += my * speed; if (pos.y < 1.7) pos.y = 1.7;
  }
}
