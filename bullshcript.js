(function () {
    let scene;

    // --- Constants & Config ---
    const STATE_KEY = "colour_drop_game_state";
    const GRID_SIZE = 8;
    const TILE_SIZE = 3;
    const GAME_HEIGHT = 15;
    let COLORS = [ // Will be converted to BS.Vector4 later
        { name: "Red", vec: [1, 0.1, 0.1, 1] },
        { name: "Green", vec: [0.1, 1, 0.1, 1] },
        { name: "Blue", vec: [0.1, 0.1, 1, 1] },
        { name: "Yellow", vec: [1, 1, 0.1, 1] },
        { name: "Magenta", vec: [1, 0.1, 1, 1] },
        { name: "Cyan", vec: [0.1, 1, 1, 1] },
        { name: "Orange", vec: [1, 0.5, 0.1, 1] },
        { name: "White", vec: [1, 1, 1, 1] }
    ];

    const TIMINGS = {
        LOBBY: 10,
        SHOWING: 5,
        DROPPED: 3,
        RESETTING: 2
    };

    // --- State Variables ---
    let gameState = {
        status: "LOBBY",
        round: 0,
        targetColorIndex: 0,
        seed: 0,
        endTime: 0
    };

    let tiles = [];
    let ui = {
        countdown: null,
        targetColorObj: null,
        targetColorMat: null,
        statusLabel: null
    };

    let audio = {
        tick: null,
        fall: null,
        win: null
    };

    // --- Utils ---
    const seededRandom = (seed) => {
        const x = Math.sin(seed) * 10000;
        return x - Math.floor(x);
    };

    const isHost = () => {
        // Ensure scene and localUser are defined before accessing
        if (!scene || !scene.localUser || !scene.users) return false;
        const uids = Object.keys(scene.users).sort();
        return uids.length > 0 && uids[0] === scene.localUser.uid;
    };

    // --- Initialization ---
    async function init() {
        console.log("Colour Drop: Starting Init");
        scene = BS.BanterScene.GetInstance();

        // Convert COLORS to BS.Vector4 now that BS is available
        COLORS = COLORS.map(c => ({ ...c, vec: new BS.Vector4(c.vec[0], c.vec[1], c.vec[2], c.vec[3]) }));

        setupSettings();
        await buildEnvironment();
        await buildGrid();
        await setupUI();
        await setupAudio();

        setupNetworking();

        setInterval(update, 100);
        console.log("Colour Drop: Init Complete");
    }

    function setupSettings() {
        const settings = new BS.SceneSettings();
        settings.EnableTeleport = true;
        settings.EnableJump = true;
        settings.SpawnPoint = new BS.Vector4(0, 0.1, 15, 180);
        scene.SetSettings(settings);
    }

    async function buildEnvironment() {
        const root = new BS.GameObject({ name: "Environment" });

        const floor = new BS.GameObject({ name: "SpectatorFloor", parent: root });
        floor.AddComponent(new BS.BanterBox({ width: 40, height: 0.5, depth: 40 }));
        floor.AddComponent(new BS.BoxCollider({ size: new BS.Vector3(40, 0.5, 40) }));
        floor.AddComponent(new BS.BanterMaterial({ color: new BS.Vector4(0.15, 0.15, 0.15, 1) }));

        const pillarPos = [{ x: -15, z: -15 }, { x: 15, z: -15 }, { x: -15, z: 15 }, { x: 15, z: 15 }];
        const pillarRoot = new BS.GameObject({ name: "Pillars", parent: root });
        pillarPos.forEach(p => {
            const pillar = new BS.GameObject({ name: "Pillar", parent: pillarRoot, localPosition: new BS.Vector3(p.x, GAME_HEIGHT / 2, p.z) });
            pillar.AddComponent(new BS.BanterCylinder({ radiusTop: 1, radiusBottom: 1, height: GAME_HEIGHT }));
            pillar.AddComponent(new BS.BanterMaterial({ color: new BS.Vector4(0.4, 0.4, 0.4, 1) }));
        });

        const ao = pillarRoot.AddComponent(new BS.BanterAOBaking({ subdivisionLevel: 1, sampleCount: 64 }));
        ao.BakeAO();

        const btn = new BS.GameObject({ name: "JoinButton", localPosition: new BS.Vector3(0, 1, 10) });
        btn.AddComponent(new BS.BanterBox({ width: 2, height: 0.6, depth: 1 }));
        btn.AddComponent(new BS.BoxCollider({ size: new BS.Vector3(2, 0.6, 1) }));
        btn.AddComponent(new BS.BanterMaterial({ color: new BS.Vector4(0, 0.6, 1, 1) }));
        btn.SetLayer(5);

        const btnText = new BS.GameObject({ name: "BtnText", parent: btn, localPosition: new BS.Vector3(0, 0.4, 0), localEulerAngles: new BS.Vector3(90, 0, 0) });
        btnText.AddComponent(new BS.BanterText({ text: "JOIN GAME", fontSize: 0.4, color: new BS.Vector4(1, 1, 1, 1) }));
        btn.On("click", () => scene.TeleportTo(new BS.Vector3(0, GAME_HEIGHT + 2, 0), 0, true));

        const deadZone = new BS.GameObject({ name: "DeadZone", localPosition: new BS.Vector3(0, 2, 0) });
        deadZone.AddComponent(new BS.BoxCollider({ isTrigger: true, size: new BS.Vector3(60, 2, 60) }));
        deadZone.AddComponent(new BS.BanterColliderEvents());
        deadZone.On("trigger-enter", () => scene.TeleportTo(new BS.Vector3(0, 0.5, 15), 180, true));
    }

    async function buildGrid() {
        const gridRoot = new BS.GameObject({ name: "GridRoot", localPosition: new BS.Vector3(0, GAME_HEIGHT, 0) });
        const offset = (GRID_SIZE * TILE_SIZE) / 2 - (TILE_SIZE / 2);

        for (let x = 0; x < GRID_SIZE; x++) {
            for (let z = 0; z < GRID_SIZE; z++) {
                const tile = new BS.GameObject({
                    name: `Tile_${x}_${z}`,
                    parent: gridRoot,
                    localPosition: new BS.Vector3(x * TILE_SIZE - offset, 0, z * TILE_SIZE - offset)
                });
                tile.AddComponent(new BS.BanterBox({ width: TILE_SIZE - 0.1, height: 0.4, depth: TILE_SIZE - 0.1 }));
                tile.AddComponent(new BS.BoxCollider({ size: new BS.Vector3(TILE_SIZE - 0.1, 0.4, TILE_SIZE - 0.1) }));
                const mat = tile.AddComponent(new BS.BanterMaterial({ color: new BS.Vector4(1, 1, 1, 1) }));
                tiles.push({ obj: tile, mat: mat, x: x, z: z });
            }
        }
    }

    async function setupUI() {
        const uiRoot = new BS.GameObject({ name: "GameUI", localPosition: new BS.Vector3(0, GAME_HEIGHT + 6, 0) });
        ui.targetColorObj = new BS.GameObject({ name: "TargetIndicator", parent: uiRoot, localPosition: new BS.Vector3(0, 3, 0) });
        ui.targetColorObj.AddComponent(new BS.BanterBox({ width: 2, height: 2, depth: 2 }));
        ui.targetColorMat = ui.targetColorObj.AddComponent(new BS.BanterMaterial({ color: new BS.Vector4(1,1,1,1) }));
        ui.targetColorObj.AddComponent(new BS.BanterBillboard({ enableYAxis: true }));

        const countObj = new BS.GameObject({ name: "Countdown", parent: uiRoot, localPosition: new BS.Vector3(0, 0, 0) });
        ui.countdown = countObj.AddComponent(new BS.BanterText({ text: "WAITING", fontSize: 4, color: new BS.Vector4(1, 1, 1, 1) }));
        countObj.AddComponent(new BS.BanterBillboard({ enableYAxis: true }));

        const statusObj = new BS.GameObject({ name: "Status", parent: uiRoot, localPosition: new BS.Vector3(0, -2, 0) });
        ui.statusLabel = statusObj.AddComponent(new BS.BanterText({ text: "Welcome", fontSize: 1, color: new BS.Vector4(1, 0.8, 0, 1) }));
        statusObj.AddComponent(new BS.BanterBillboard({ enableYAxis: true }));
    }

    async function setupAudio() {
        const audioRoot = new BS.GameObject({ name: "Audio" });
        audio.tick = audioRoot.AddComponent(new BS.BanterAudioSource({ volume: 0.5, loop: false, playOnAwake: false }));
    }

    function setupNetworking() {
        scene.On("space-state-changed", (e) => {
            if (e.detail.changes.some(c => c.property === STATE_KEY)) sync();
        });
        sync();
    }

    function sync() {
        const raw = scene.spaceState.public[STATE_KEY];
        if (!raw) return;
        gameState = JSON.parse(raw);
        updateVisuals();
    }

    function updateVisuals() {
        tiles.forEach((tile, index) => {
            const colorIdx = Math.floor(seededRandom(gameState.seed + index) * COLORS.length);
            tile.mat.color = COLORS[colorIdx].vec;
            tile.obj.SetActive(gameState.status !== "DROPPED" || colorIdx === gameState.targetColorIndex);
        });

        if (gameState.status === "SHOWING") {
            ui.targetColorObj.SetActive(true);
            ui.targetColorMat.color = COLORS[gameState.targetColorIndex].vec;
            ui.statusLabel.text = `Stand on ${COLORS[gameState.targetColorIndex].name.toUpperCase()}!`;
        } else {
            ui.targetColorObj.SetActive(gameState.status === "DROPPED");
            if (gameState.status === "LOBBY") ui.statusLabel.text = "Waiting for game...";
            if (gameState.status === "DROPPED") ui.statusLabel.text = "Watch out!";
            if (gameState.status === "RESETTING") ui.statusLabel.text = "Get Ready...";
        }
    }

    let lastTick = 0;
    function update() {
        const now = Date.now();
        const remaining = Math.max(0, Math.ceil((gameState.endTime - now) / 1000));

        if (gameState.status === "SHOWING") {
            ui.countdown.text = remaining.toString();
            if (remaining <= 3 && remaining > 0 && remaining !== lastTick) {
                audio.tick.PlayOneShotFromUrl("https://firer.at/files/tick.mp3");
                lastTick = remaining;
            }
        } else if (gameState.status === "LOBBY") ui.countdown.text = "COLOUR DROP";
        else if (gameState.status === "DROPPED") ui.countdown.text = "!!!";
        else ui.countdown.text = "WAIT";

        if (isHost()) driveHostLogic(now);
    }

    function driveHostLogic(now) {
        if (now < gameState.endTime) return;
        if (gameState.status === "LOBBY") startNextRound(1);
        else if (gameState.status === "SHOWING") updateState({ status: "DROPPED", endTime: now + (TIMINGS.DROPPED * 1000) });
        else if (gameState.status === "DROPPED") updateState({ status: "RESETTING", endTime: now + (TIMINGS.RESETTING * 1000) });
        else if (gameState.status === "RESETTING") startNextRound(gameState.round + 1);
    }

    function startNextRound(roundNum) {
        updateState({
            status: "SHOWING",
            round: roundNum,
            seed: Math.floor(Math.random() * 999999),
            targetColorIndex: Math.floor(Math.random() * COLORS.length),
            endTime: Date.now() + (Math.max(1.5, TIMINGS.SHOWING - (roundNum * 0.4)) * 1000)
        });
    }

    function updateState(patch) {
        const next = { ...gameState, ...patch };
        scene.SetPublicSpaceProps({ [STATE_KEY]: JSON.stringify(next) });
    }

    // --- Entry Point ---
    window.addEventListener("bs-loaded", init);
})();
