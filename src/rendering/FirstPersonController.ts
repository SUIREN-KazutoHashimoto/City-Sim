import * as THREE from 'three';
export class FirstPersonController {
  private yaw: number; private pitch = 0; private readonly keys = new Set<string>(); private dragging = false;
  moveSpeed = 40; sprintMultiplier = 4; lookSensitivity = 0.0035;
  private forward = new THREE.Vector3(); private right = new THREE.Vector3();
  private followTarget: THREE.Vector3 | null = null; followDistance = 10;
  constructor(private camera: THREE.PerspectiveCamera, private domElement: HTMLElement, startYaw = 0, startPitch = 0) { this.yaw = startYaw; this.pitch = startPitch; this.bind(); this.applyRotation(); }
  private bind(): void {
    this.domElement.addEventListener('mousedown', (e) => { if (e.button === 0) { this.dragging = true; e.preventDefault(); } });
    window.addEventListener('mouseup', (e) => { if (e.button === 0) this.dragging = false; });
    document.addEventListener('mousemove', (e) => { if (!this.dragging) return; this.yaw -= e.movementX * this.lookSensitivity; this.pitch -= e.movementY * this.lookSensitivity; const lim = Math.PI / 2 - 0.01; this.pitch = Math.max(-lim, Math.min(lim, this.pitch)); this.applyRotation(); });
    this.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => this.keys.add(e.code)); window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this.dragging = false; });
  }
  private applyRotation(): void { this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ')); }
  setPosition(x: number, y: number, z: number): void { this.camera.position.set(x, y, z); }
  get isDragging(): boolean { return this.dragging; }
  setFollowTarget(t: THREE.Vector3 | null): void { this.followTarget = t; }
  get isFollowing(): boolean { return this.followTarget !== null; }
  update(dt: number): void {
    if (this.followTarget) { const t = this.followTarget, d = this.followDistance, cp = Math.cos(this.pitch); this.camera.position.set(t.x - Math.sin(this.yaw) * cp * d, t.y + Math.sin(this.pitch) * d + 1.2, t.z - Math.cos(this.yaw) * cp * d); this.camera.lookAt(t.x, t.y + 1.0, t.z); return; }
    this.forward.set(0, 0, -1).applyQuaternion(this.camera.quaternion); this.right.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    let mx = 0, mz = 0, my = 0;
    if (this.keys.has('KeyW')) mz += 1; if (this.keys.has('KeyS')) mz -= 1; if (this.keys.has('KeyD')) mx += 1; if (this.keys.has('KeyA')) mx -= 1;
    if (this.keys.has('KeyE') || this.keys.has('Space')) my += 1; if (this.keys.has('KeyQ') || this.keys.has('ControlLeft') || this.keys.has('ControlRight')) my -= 1;
    const sprint = this.keys.has('ShiftLeft'), speed = this.moveSpeed * (sprint ? this.sprintMultiplier : 1) * dt;
    const pos = this.camera.position; pos.addScaledVector(this.forward, mz * speed); pos.addScaledVector(this.right, mx * speed); pos.y += my * speed; if (pos.y < 1.7) pos.y = 1.7;
  }
}
