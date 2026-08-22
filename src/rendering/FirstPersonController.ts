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
 *    Q / Space         上昇 / E / Ctrl 下降(ワールド垂直)
 *    Left Shift        加速(ダッシュ)
 *
 *  追跡モード:
 *    setFollowTarget() で対象を渡すと、対象を周回する三人称カメラになる。
 *    左ドラッグで周回、ホイールで距離(followDistance)を調整する想定。
 *
 * 挙動は毎フレーム update(dt) を呼ぶだけ。シミュレーション本体とは独立。
 * 将来「特定エージェントに憑依する三人称/一人称追従」へ拡張する際も、
 * このクラスの position/quaternion を上書きするだけで差し替えられる。
 */
export class FirstPersonController {
  private yaw: number;
  private pitch = 0;
  private readonly keys = new Set<string>();
  /** 左ボタンを押している間だけ視点回転する */
  private dragging = false;

  /** 基本移動速度 (m/s)。LShiftで sprintMultiplier 倍。 */
  moveSpeed = 40;
  sprintMultiplier = 4;
  /** マウス感度(ラジアン / ピクセル) */
  lookSensitivity = 0.0035;

  private forward = new THREE.Vector3();
  private right = new THREE.Vector3();

  // --- 追跡(三人称)モード ---
  /** 追跡対象のワールド座標。null なら自由移動モード。 */
  private followTarget: THREE.Vector3 | null = null;
  /** 追跡時のカメラ距離(m)。ホイールで調整。 */
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
    // 左ボタン押下中のみ視点をドラッグ回転する
    this.domElement.addEventListener('mousedown', (e) => {
      if (e.button === 0) { this.dragging = true; e.preventDefault(); }
    });
    // ボタンを離す/カーソルが外へ出たら回転を止める
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.dragging = false;
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.dragging) return;
      // ドラッグ量(movementX/Y)ぶんだけ視線を回す
      this.yaw -= e.movementX * this.lookSensitivity;
      this.pitch -= e.movementY * this.lookSensitivity;
      // 真上・真下でのジンバル反転を防ぐためクランプ
      const limit = Math.PI / 2 - 0.01;
      this.pitch = Math.max(-limit, Math.min(limit, this.pitch));
      this.applyRotation();
    });
    // ドラッグ中に選択・コンテキストメニューが出ないよう抑制
    this.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
    // キー入力(押している間 Set に保持)
    window.addEventListener('keydown', (e) => this.keys.add(e.code));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    // フォーカスを失ったら全キー解放+ドラッグ解除(押しっぱなし暴走の防止)
    window.addEventListener('blur', () => { this.keys.clear(); this.dragging = false; });
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

  get isDragging(): boolean { return this.dragging; }

  /** 追跡対象を設定/解除する。null で自由移動モードへ戻る。 */
  setFollowTarget(t: THREE.Vector3 | null): void { this.followTarget = t; }
  get isFollowing(): boolean { return this.followTarget !== null; }

  /** 毎フレーム呼ぶ。dt は実時間秒。 */
  update(dt: number): void {
    // 追跡モード: 対象を yaw/pitch/followDistance で周回するオービットカメラ。
    if (this.followTarget) {
      const t = this.followTarget;
      const d = this.followDistance;
      // yaw/pitch から対象を見下ろす球面座標でカメラ位置を決める
      const cp = Math.cos(this.pitch);
      this.camera.position.set(
        t.x - Math.sin(this.yaw) * cp * d,
        t.y + Math.sin(this.pitch) * d + 1.2, // やや上から
        t.z - Math.cos(this.yaw) * cp * d,
      );
      this.camera.lookAt(t.x, t.y + 1.0, t.z);
      return; // 追跡中は WASD 移動を無効化
    }

    // --- 自由移動モード ---
    // カメラのローカル基底を現在の姿勢(quaternion)から直接取り出す。
    //   ローカル前方 = -Z, ローカル右 = +X。pitch も反映されるため、
    //   視線を上/下に向けたまま W を押すと、その視線方向へ飛ぶ(カメラローカル基準)。
    this.forward.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    this.right.set(1, 0, 0).applyQuaternion(this.camera.quaternion);

    let mx = 0, mz = 0, my = 0;
    if (this.keys.has('KeyW')) mz += 1;
    if (this.keys.has('KeyS')) mz -= 1;
    if (this.keys.has('KeyD')) mx += 1;
    if (this.keys.has('KeyA')) mx -= 1;
    // 上昇: Q または Space / 下降: E または Ctrl(いずれもワールド垂直)
    if (this.keys.has('KeyQ') || this.keys.has('Space')) my += 1;
    if (this.keys.has('KeyE') || this.keys.has('ControlLeft') || this.keys.has('ControlRight')) my -= 1;

    const sprint = this.keys.has('ShiftLeft');
    const speed = this.moveSpeed * (sprint ? this.sprintMultiplier : 1) * dt;

    const pos = this.camera.position;
    pos.addScaledVector(this.forward, mz * speed); // 視線前方(pitch込み)
    pos.addScaledVector(this.right, mx * speed);   // 視線右方
    pos.y += my * speed;                            // Q/E/Space/Ctrl はワールド垂直
    // 地面へめり込まない最低目線高さ
    if (pos.y < 1.7) pos.y = 1.7;
  }
}
