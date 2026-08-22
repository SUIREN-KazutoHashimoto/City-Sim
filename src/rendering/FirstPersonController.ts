import * as THREE from 'three';

/**
 * ============================================================================
 *  一人称カメラコントローラ (左ドラッグ視点 + WASDQE)
 * ============================================================================
 * FPS流の視点移動。左クリック押下中のマウス移動で視線(yaw/pitch)、キーで移動する。
 *
 *  操作:
 *    左クリック+移動  視点回転(ドラッグ式。ポインターロックは使わない)
 *    W / A / S / D    カメラローカル基準の前後左右(pitch込みで視線方向へ飛ぶ)
 *    Q / E            上昇 / 下降(ワールド垂直・高度調整用に固定)
 *    Left Shift       加速(ダッシュ)
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

  /** 毎フレーム呼ぶ。dt は実時間秒。 */
  update(dt: number): void {
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
    if (this.keys.has('KeyQ')) my += 1; // 上昇(ワールド垂直・高度調整用に固定)
    if (this.keys.has('KeyE')) my -= 1; // 下降

    const sprint = this.keys.has('ShiftLeft');
    const speed = this.moveSpeed * (sprint ? this.sprintMultiplier : 1) * dt;

    const pos = this.camera.position;
    pos.addScaledVector(this.forward, mz * speed); // 視線前方(pitch込み)
    pos.addScaledVector(this.right, mx * speed);   // 視線右方
    pos.y += my * speed;                            // Q/E はワールド垂直
    // 地面へめり込まない最低目線高さ
    if (pos.y < 1.7) pos.y = 1.7;
  }
}
