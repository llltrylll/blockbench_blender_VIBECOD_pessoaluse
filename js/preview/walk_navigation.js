import { THREE } from '../lib/libs';

/**
 * Keyboard-and-mouse first-person navigation for the active Blockbench viewport.
 * Left click commits the camera move; right click or Esc restores the entry pose.
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
		this.previousFov = null;
		this.fovValue = 100;
		try {
			const savedFov = Number(localStorage.getItem('blockbench_viewport_fov'));
			if (Number.isFinite(savedFov) && savedFov >= 30 && savedFov <= 140) {
				this.fovValue = Math.round(savedFov);
			}
		} catch (error) {}
		this.fovPanel = null;
		this.lockButton = null;
		this.temporarilyUnlocked = false;
		this.cancelOnExit = false;
		this.savedPose = null;
		this.suppressNextContextMenu = false;

		this.onPointerLockChange = this.onPointerLockChange.bind(this);
		this.onMouseMove = this.onMouseMove.bind(this);
		this.onKeyDown = this.onKeyDown.bind(this);
		this.onKeyUp = this.onKeyUp.bind(this);
		this.onPointerDown = this.onPointerDown.bind(this);
		this.update = this.update.bind(this);
		this.onWindowBlur = this.onWindowBlur.bind(this);

		document.addEventListener('pointerlockchange', this.onPointerLockChange);
		document.addEventListener('mousemove', this.onMouseMove);
		document.addEventListener('keydown', this.onKeyDown, true);
		document.addEventListener('keyup', this.onKeyUp, true);
		document.addEventListener('pointerdown', this.onPointerDown, true);
		window.addEventListener('blur', this.onWindowBlur);
		this.createFovControl();
	}

	toggle() {
		if (this.active || document.pointerLockElement === this.canvas) {
			this.cancelOnExit = false;
			if (this.temporarilyUnlocked) this.stop();
			else document.exitPointerLock?.();
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
		} else if (this.active && this.temporarilyUnlocked) {
			this.updateFovControlState();
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
		this.temporarilyUnlocked = false;
		this.cancelOnExit = false;
		this.suppressNextContextMenu = false;
		this.previousControlsEnabled = this.controls.enabled;
		this.savedPose = {
			position: camera.position.clone(),
			quaternion: camera.quaternion.clone(),
			rotationOrder: camera.rotation.order,
			target: this.controls.target.clone()
		};
		this.applyFov?.(this.fovValue);
		this.controls.enabled = false;
		this.keys.clear();

		const direction = camera.getWorldDirection(new THREE.Vector3()).normalize();
		this.yaw = Math.atan2(-direction.x, -direction.z);
		this.pitch = Math.asin(Math.max(-1, Math.min(1, direction.y)));
		this.lastTime = performance.now();
		this.createFovControl();
		this.frame = requestAnimationFrame(this.update);
		Blockbench.showQuickMessage('First person: WASD · Q/E vertical · Shift faster · [ ] FOV · Tab edit FOV · LMB confirm · RMB/Esc cancel', 5500);
	}

	createFovControl() {
		const parent = this.canvas.parentElement;
		if (!parent) return;
		if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';

		if (this.fovPanel?.isConnected) return;
		const panel = document.createElement('div');
		panel.className = 'walk_navigation_fov';
		Object.assign(panel.style, {
			position: 'absolute',
			top: '12px',
			left: '12px',
			zIndex: '10000',
			display: 'flex',
			alignItems: 'center',
			gap: '7px',
			padding: '7px 9px',
			borderRadius: '5px',
			background: 'rgba(20, 22, 26, 0.88)',
			color: '#ffffff',
			font: '12px sans-serif',
			boxShadow: '0 1px 5px rgba(0,0,0,.4)',
			pointerEvents: 'auto'
		});

		const label = document.createElement('span');
		label.textContent = 'FOV';
		const number = document.createElement('input');
		number.type = 'number';
		number.min = '30';
		number.max = '140';
		number.step = '1';
		number.value = String(this.fovValue);
		Object.assign(number.style, {
			width: '48px',
			padding: '2px 3px',
			border: '1px solid #666',
			borderRadius: '3px',
			background: '#17191d',
			color: '#ffffff'
		});
		const slider = document.createElement('input');
		slider.type = 'range';
		slider.min = '30';
		slider.max = '140';
		slider.step = '1';
		slider.value = String(this.fovValue);
		slider.title = 'Use [ and ] while pointer is locked';
		Object.assign(slider.style, {width: '110px', accentColor: '#e0b44c'});
		const degrees = document.createElement('span');
		degrees.textContent = '°';
		const lockButton = document.createElement('button');
		lockButton.type = 'button';
		lockButton.textContent = 'Resume';
		Object.assign(lockButton.style, {
			padding: '3px 6px',
			border: '1px solid #777',
			borderRadius: '3px',
			background: '#33383f',
			color: '#fff',
			cursor: 'pointer'
		});
		lockButton.addEventListener('click', () => this.resumePointerLock());
		panel.addEventListener('pointerdown', event => event.stopPropagation());

		const applyFov = value => {
			const parsed = Number(value);
			if (!Number.isFinite(parsed)) return;
			this.fovValue = Math.max(30, Math.min(140, Math.round(parsed)));
			number.value = String(this.fovValue);
			slider.value = String(this.fovValue);
			const preview = this.canvas.preview;
			const camera = preview?.camPers || this.controls.object;
			if (camera?.isPerspectiveCamera) {
				camera.fov = this.fovValue;
				camera.updateProjectionMatrix();
			}
			try {
				localStorage.setItem('blockbench_viewport_fov', String(this.fovValue));
			} catch (error) {}
		};
		number.addEventListener('change', () => applyFov(number.value));
		number.addEventListener('keydown', event => {
			if (event.key === 'Enter') {
				event.preventDefault();
				number.blur();
			}
		});
		slider.addEventListener('input', () => applyFov(slider.value));
		panel.append(label, number, slider, degrees, lockButton);
		parent.appendChild(panel);
		this.fovPanel = panel;
		this.lockButton = lockButton;
		this.applyFov = applyFov;
		this.applyFov(this.fovValue);
		this.updateFovControlState();
	}

	updateFovControlState() {
		if (this.lockButton) this.lockButton.style.display = this.active && this.temporarilyUnlocked ? '' : 'none';
	}

	resumePointerLock() {
		if (!this.active || !this.temporarilyUnlocked) return;
		try {
			const request = this.canvas.requestPointerLock();
			this.temporarilyUnlocked = false;
			this.updateFovControlState();
			if (request && typeof request.catch === 'function') {
				request.catch(() => {
					this.temporarilyUnlocked = true;
					this.updateFovControlState();
				});
			}
		} catch (error) {
			this.temporarilyUnlocked = true;
			this.updateFovControlState();
		}
	}

	onPointerDown(event) {
		if (!this.active || (event.button !== 0 && event.button !== 2)) return;
		if (this.fovPanel?.contains(event.target)) return;
		const insidePreview = event.target === this.canvas || this.canvas.contains(event.target);
		if (this.temporarilyUnlocked && !insidePreview) {
			this.cancelOnExit = event.button === 2;
			this.stop();
			return;
		}
		if (!insidePreview) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		this.suppressNextContextMenu = true;
		this.cancelOnExit = event.button === 2;
		if (this.temporarilyUnlocked) this.stop();
		else document.exitPointerLock?.();
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
			if (this.cancelOnExit && this.savedPose) {
				camera.position.copy(this.savedPose.position);
				camera.quaternion.copy(this.savedPose.quaternion);
				camera.rotation.order = this.savedPose.rotationOrder;
				this.controls.target.copy(this.savedPose.target);
			} else {
				const direction = camera.getWorldDirection(new THREE.Vector3()).normalize();
				this.controls.target.copy(camera.position).addScaledVector(direction, 10);
			}
			this.controls.update();
		}
		this.temporarilyUnlocked = false;
		this.updateFovControlState();
		this.previousFov = null;
		this.savedPose = null;
		this.cancelOnExit = false;
	}

	onMouseMove(event) {
		if (!this.active || this.temporarilyUnlocked) return;
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
		if (this.fovPanel?.contains(event.target)) return;
		if (event.code === 'Escape') {
			event.preventDefault();
			event.stopImmediatePropagation();
			this.cancelOnExit = true;
			if (this.temporarilyUnlocked) this.stop();
			else document.exitPointerLock?.();
			return;
		}
		if (event.code === 'Backquote' && event.ctrlKey) return;
		if (event.code === 'Tab') {
			event.preventDefault();
			event.stopImmediatePropagation();
			if (this.temporarilyUnlocked) this.resumePointerLock();
			else {
				this.temporarilyUnlocked = true;
				this.updateFovControlState();
				document.exitPointerLock?.();
			}
			return;
		}

		if (['BracketLeft', 'NumpadSubtract', 'BracketRight', 'NumpadAdd'].includes(event.code)) {
			const direction = (event.code === 'BracketLeft' || event.code === 'NumpadSubtract') ? -1 : 1;
			const step = event.shiftKey ? 5 : 1;
			this.applyFov?.(this.fovValue + direction * step);
			event.preventDefault();
			event.stopImmediatePropagation();
			return;
		}

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
		document.removeEventListener('pointerdown', this.onPointerDown, true);
		window.removeEventListener('blur', this.onWindowBlur);
	}
}
