import { THREE } from '../lib/libs';

/**
 * Keyboard-and-mouse first-person navigation for the active Blockbench viewport.
 * Pointer Lock keeps mouse look independent from the normal orbit drag controls.
 */
export default class WalkNavigation {
	constructor(controls) {
		this.controls = controls;
		this.canvas = controls.domElement;
		this.active = false;
		this.keys = new Set();
		this.frame = 0;
		this.lastTime = 0;
		this.speed = 18;
		this.sensitivity = 0.0022;
		this.yaw = 0;
		this.pitch = 0;
		this.previousControlsEnabled = true;

		this.onPointerLockChange = this.onPointerLockChange.bind(this);
		this.onMouseMove = this.onMouseMove.bind(this);
		this.onKeyDown = this.onKeyDown.bind(this);
		this.onKeyUp = this.onKeyUp.bind(this);
		this.update = this.update.bind(this);
		this.onWindowBlur = this.onWindowBlur.bind(this);

		document.addEventListener('pointerlockchange', this.onPointerLockChange);
		document.addEventListener('mousemove', this.onMouseMove);
		document.addEventListener('keydown', this.onKeyDown, true);
		document.addEventListener('keyup', this.onKeyUp, true);
		window.addEventListener('blur', this.onWindowBlur);
	}

	toggle() {
		if (this.active || document.pointerLockElement === this.canvas) {
			document.exitPointerLock?.();
			return;
		}
		this.enter();
	}

	enter() {
		const camera = this.controls.object;
		if (!camera || !camera.isPerspectiveCamera) {
			Blockbench.showQuickMessage('First-person navigation requires perspective view.');
			return;
		}
		if (typeof this.canvas.requestPointerLock !== 'function') {
			Blockbench.showQuickMessage('Pointer Lock is not supported by this viewport.');
			return;
		}
		try {
			const request = this.canvas.requestPointerLock();
			if (request && typeof request.catch === 'function') {
				request.catch(() => Blockbench.showQuickMessage('Could not capture the mouse pointer.'));
			}
		} catch (error) {
			Blockbench.showQuickMessage('Could not capture the mouse pointer.');
			console.warn('Could not enter first-person navigation', error);
		}
	}

	onPointerLockChange() {
		if (document.pointerLockElement === this.canvas) {
			if (!this.active) this.start();
		} else if (this.active) {
			this.stop();
		}
	}

	start() {
		const camera = this.controls.object;
		if (!camera || !camera.isPerspectiveCamera) {
			document.exitPointerLock?.();
			return;
		}
		this.active = true;
		this.previousControlsEnabled = this.controls.enabled;
		this.controls.enabled = false;
		this.keys.clear();

		const direction = camera.getWorldDirection(new THREE.Vector3()).normalize();
		this.yaw = Math.atan2(-direction.x, -direction.z);
		this.pitch = Math.asin(Math.max(-1, Math.min(1, direction.y)));
		this.lastTime = performance.now();
		this.frame = requestAnimationFrame(this.update);
		Blockbench.showQuickMessage('First person: WASD · Q/E vertical · Mouse · Shift faster · Esc exit', 4500);
	}

	stop() {
		if (!this.active) return;
		this.active = false;
		this.keys.clear();
		if (this.frame) cancelAnimationFrame(this.frame);
		this.frame = 0;
		this.controls.enabled = this.previousControlsEnabled;

		const camera = this.controls.object;
		if (camera && camera.isPerspectiveCamera) {
			const direction = camera.getWorldDirection(new THREE.Vector3()).normalize();
			this.controls.target.copy(camera.position).addScaledVector(direction, 10);
			this.controls.update();
		}
	}

	onMouseMove(event) {
		if (!this.active) return;
		this.yaw -= (event.movementX || 0) * this.sensitivity;
		this.pitch -= (event.movementY || 0) * this.sensitivity;
		this.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this.pitch));
		event.preventDefault();
		event.stopPropagation();

		const camera = this.controls.object;
		if (!camera || !camera.isPerspectiveCamera) {
			document.exitPointerLock?.();
			return;
		}
		camera.rotation.order = 'YXZ';
		camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
		const direction = camera.getWorldDirection(new THREE.Vector3()).normalize();
		this.controls.target.copy(camera.position).addScaledVector(direction, 10);
		this.controls.update();
	}

	onKeyDown(event) {
		if (!this.active) return;
		if (event.code === 'Escape') {
			event.preventDefault();
			event.stopImmediatePropagation();
			document.exitPointerLock?.();
			return;
		}
		if (event.code === 'Backquote' && event.ctrlKey) return;

		const movementKeys = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight'];
		if (movementKeys.includes(event.code)) this.keys.add(event.code);
		event.preventDefault();
		event.stopImmediatePropagation();
	}

	onWindowBlur() {
		this.keys.clear();
	}

	onKeyUp(event) {
		if (!this.active) return;
		if (this.keys.has(event.code)) {
			this.keys.delete(event.code);
			event.preventDefault();
			event.stopImmediatePropagation();
		}
	}

	update(time) {
		if (!this.active) return;
		const delta = Math.min(Math.max((time - this.lastTime) / 1000, 0), 0.05);
		this.lastTime = time;

		const camera = this.controls.object;
		if (!camera || !camera.isPerspectiveCamera) {
			document.exitPointerLock?.();
			return;
		}
		// Keep WASD movement on the horizontal plane; looking up/down must not make the camera fly.
		const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)).normalize();
		const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw)).normalize();
		const up = new THREE.Vector3(0, 1, 0);
		const movement = new THREE.Vector3();

		if (this.keys.has('KeyW')) movement.add(forward);
		if (this.keys.has('KeyS')) movement.sub(forward);
		if (this.keys.has('KeyD')) movement.add(right);
		if (this.keys.has('KeyA')) movement.sub(right);
		if (this.keys.has('KeyQ')) movement.add(up);
		if (this.keys.has('KeyE')) movement.sub(up);

		if (movement.lengthSq() > 0) {
			movement.normalize();
			const fast = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
			movement.multiplyScalar(this.speed * delta * (fast ? 3 : 1));
			camera.position.add(movement);
			this.controls.target.add(movement);
			this.controls.update();
		}
		this.frame = requestAnimationFrame(this.update);
	}

	dispose() {
		if (document.pointerLockElement === this.canvas) document.exitPointerLock?.();
		this.stop();
		document.removeEventListener('pointerlockchange', this.onPointerLockChange);
		document.removeEventListener('mousemove', this.onMouseMove);
		document.removeEventListener('keydown', this.onKeyDown, true);
		document.removeEventListener('keyup', this.onKeyUp, true);
		window.removeEventListener('blur', this.onWindowBlur);
	}
}
