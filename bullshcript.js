(function () {
    let scene;

    // --- Configuration ---
    const STATE_KEY = "colour_drop_game_state";
    const GRID_SIZE = 8;
    const TILE_SIZE = 3;
    const GAME_HEIGHT = 15;
    const LOBBY_POS_RAW = { x: 0, y: 0.1, z: -40 };

    let COLORS = [
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
        SHOWING: 7,
        DROPPED: 3,
        RESETTING: 3
    };

    // --- State Variables ---
    let gameState = {
        status: "LOBBY",
        round: 0,
        targetColorIndex: 0,
        seed: 0,
        endTime: 0,
        hardMode: false,
        initialCountdown: 7
    };

    let tiles = [];
    let ui = { root: null, displays: [] };
    let audio = { tick: null };

    // --- Utils ---
    const seededRandom = (seed) => {
        const x = Math.sin(seed) * 10000;
        return x - Math.floor(x);
    };

    const isHost = () => {
        if (!scene || !scene.localUser || !scene.users) return false;
        const uids = Object.keys(scene.users).sort();
        return uids.length > 0 && uids[0] === scene.localUser.uid;
    };

    // --- Initialization ---
    async function init() {
        if (scene) return;
        scene = BS.BanterScene.GetInstance();

        console.log("Colour Drop: Calling setupSettings before Unity load check.");
        setupSettings();

        if (!scene.unityLoaded) {
            console.log("Colour Drop: Waiting for Unity...");
            await new Promise(resolve => {
                scene.On("unity-loaded", resolve);
                window.addEventListener("unity-loaded", resolve, { once: true });
            });
        }
        console.log("Colour Drop: Unity Loaded!");

        COLORS = COLORS.map(c => ({ ...c, vec: new BS.Vector4(c.vec[0], c.vec[1], c.vec[2], c.vec[3]) }));

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
        settings.MaxOccupancy = 30;
        settings.RefreshRate = 72;
        settings.ClippingPlane = new BS.Vector2(0.05, 500);
        settings.SpawnPoint = new BS.Vector4(LOBBY_POS_RAW.x, LOBBY_POS_RAW.y, LOBBY_POS_RAW.z, 0);

        console.log("Colour Drop: Applying scene settings.");
        scene.SetSettings(settings);
        scene.TeleportTo(new BS.Vector3(LOBBY_POS_RAW.x, LOBBY_POS_RAW.y, LOBBY_POS_RAW.z), 0, true);

        setTimeout(() => {
            console.log("Colour Drop: Re-applying settings via timeout.");
            scene.SetSettings(settings);
            scene.TeleportTo(new BS.Vector3(LOBBY_POS_RAW.x, LOBBY_POS_RAW.y, LOBBY_POS_RAW.z), 0, true);
        }, 2000);
    }

    async function buildEnvironment() {
        const root = new BS.GameObject({ name: "Environment" });

        // Lobby Floor
        const floor = await new BS.GameObject({ name: "SpectatorLobby", parent: root, localPosition: new BS.Vector3(LOBBY_POS_RAW.x, LOBBY_POS_RAW.y - 0.05, LOBBY_POS_RAW.z) });
        await floor.AddComponent(new BS.BanterBox({ width: 30, height: 0.5, depth: 30 }));
        await floor.AddComponent(new BS.BoxCollider({ size: new BS.Vector3(30, 0.5, 30) }));
        await floor.AddComponent(new BS.BanterMaterial({ color: new BS.Vector4(0.1, 0.1, 0.1, 1) }));

        // Buttons Container - Centered in lobby
        const buttonGroup = await new BS.GameObject({ name: "Controls", parent: floor, localPosition: new BS.Vector3(0, 1, 0) });

        // helper for buttons
        const createBtn = async (name, xPos, color, text, handler) => {
            const btn = await new BS.GameObject({ name: name, parent: buttonGroup, localPosition: new BS.Vector3(xPos, 0, 0) });
            await btn.AddComponent(new BS.BanterBox({ width: 1, height: 0.4, depth: 0.5 }));
            await btn.AddComponent(new BS.BoxCollider({ size: new BS.Vector3(1, 0.4, 0.5) }));
            await btn.AddComponent(new BS.BanterMaterial({ color: color }));
            btn.SetLayer(5);

            const t = await new BS.GameObject({ name: name + "Text", parent: btn, localPosition: new BS.Vector3(0, 0.25, 0), localEulerAngles: new BS.Vector3(90, 0, 0) });
            await t.AddComponent(new BS.BanterText({
                text: text,
                fontSize: 2,
                color: new BS.Vector4(1, 1, 1, 1),
                horizontalAlignment: BS.HorizontalAlignment.Center,
                verticalAlignment: BS.VerticalAlignment.Middle
            }));

            btn.On("click", handler);
            return btn;
        };

        // Aligning buttons strictly: Join at -3, HardMode at -6, others to the right
        await createBtn("HardModeBtn", -6, new BS.Vector4(0.8, 0.1, 0.1, 1), "HARD MODE: OFF", () => {
            if (!isHost()) return;
            updateState({ hardMode: !gameState.hardMode });
        });

        await createBtn("JoinBtn", -3, new BS.Vector4(0, 0.5, 1, 1), "JOIN GAME", () => {
            scene.SetUserProps({ inGame: "true" }, scene.localUser.uid);
            scene.TeleportTo(new BS.Vector3(0, GAME_HEIGHT + 2, 0), 0, true);
        });

        await createBtn("Timer5Btn", 0, new BS.Vector4(0.1, 0.8, 0.1, 1), "SET: 5S", () => {
            if (!isHost()) return;
            updateState({ initialCountdown: 5 });
        });

        await createBtn("Timer10Btn", 3, new BS.Vector4(0.1, 0.8, 0.1, 1), "SET: 10S", () => {
            if (!isHost()) return;
            updateState({ initialCountdown: 10 });
        });

        await createBtn("ResetBtn", 6, new BS.Vector4(0.5, 0.5, 0.5, 1), "RESET GAME", () => {
            if (!isHost()) return;
            updateState({ status: "LOBBY", round: 0 });
        });

        // Death Zone
        const deadZone = new BS.GameObject({ name: "DeadZone", localPosition: new BS.Vector3(0, 5, 0) });
        await deadZone.AddComponent(new BS.BoxCollider({ isTrigger: true, size: new BS.Vector3(100, 2, 100) }));
        await deadZone.AddComponent(new BS.BanterColliderEvents());
        deadZone.On("trigger-enter", (e) => {
            console.log("DeadZone: trigger-enter detected");
            if (e.detail.user && e.detail.user.isLocal) {
                if (scene.localUser.props.inGame === "true") {
                    console.log("DeadZone: Local player fell! Teleporting to lobby.");
                    scene.SetUserProps({ inGame: "false" }, scene.localUser.uid);
                    scene.TeleportTo(new BS.Vector3(LOBBY_POS_RAW.x, LOBBY_POS_RAW.y, LOBBY_POS_RAW.z), 180, true);
                }
            }
        });
    }

    async function buildGrid() {
        const gridRoot = new BS.GameObject({ name: "GridRoot", localPosition: new BS.Vector3(0, GAME_HEIGHT, 0) });
        const offset = (GRID_SIZE * TILE_SIZE) / 2 - (TILE_SIZE / 2);

        for (let x = 0; x < GRID_SIZE; x++) {
            for (let z = 0; z < GRID_SIZE; z++) {
                const tileName = `Tile_${x}_${z}`;
                const tile = new BS.GameObject({
                    name: tileName,
                    parent: gridRoot,
                    localPosition: new BS.Vector3(x * TILE_SIZE - offset, 0, z * TILE_SIZE - offset)
                });
                await tile.AddComponent(new BS.BanterBox({ width: TILE_SIZE - 0.1, height: 0.4, depth: TILE_SIZE - 0.1 }));
                await tile.AddComponent(new BS.BoxCollider({ size: new BS.Vector3(TILE_SIZE - 0.1, 0.4, TILE_SIZE - 0.1) }));
                const mat = await tile.AddComponent(new BS.BanterMaterial("Unlit/Diffuse", "", new BS.Vector4(1, 1, 1, 1), BS.MaterialSide.Front, false, tileName));
                tiles.push({ obj: tile, mat: mat, x: x, z: z });
            }
        }
    }

    async function setupUI() {
        const uiAnchor = new BS.GameObject({ name: "UIAnchor", localPosition: new BS.Vector3(0, GAME_HEIGHT + 12, 0) });
        ui.root = uiAnchor;

        const createDisplay = async (name, pos, rot) => {
            const panel = new BS.GameObject({ name: name, parent: uiAnchor, localPosition: pos, localEulerAngles: rot });
            const textObj = new BS.GameObject({ name: "Label", parent: panel, localPosition: new BS.Vector3(0, 4, 0) });
            const textComp = await textObj.AddComponent(new BS.BanterText({ text: "COLOUR DROP", fontSize: 12, color: new BS.Vector4(1, 1, 1, 1), horizontalAlignment: BS.HorizontalAlignment.Center }));
            const cube = new BS.GameObject({ name: "ColorCube", parent: panel, localPosition: new BS.Vector3(0, -1, 0) });
            await cube.AddComponent(new BS.BanterBox({ width: 5, height: 5, depth: 5 }));
            const mat = await cube.AddComponent(new BS.BanterMaterial({ color: new BS.Vector4(1, 1, 1, 1) }));
            return { text: textComp, mat: mat, cube: cube };
        };

        ui.displays = [
            await createDisplay("DisplayN", new BS.Vector3(0, 0, 15), new BS.Vector3(0, 0, 0)),
            await createDisplay("DisplayS", new BS.Vector3(0, 0, -15), new BS.Vector3(0, 180, 0)),
            await createDisplay("DisplayE", new BS.Vector3(15, 0, 0), new BS.Vector3(0, 90, 0)),
            await createDisplay("DisplayW", new BS.Vector3(-15, 0, 0), new BS.Vector3(0, -90, 0))
        ];
    }

    async function setupAudio() {
        const audioRoot = new BS.GameObject({ name: "Audio" });
        audio.tick = await audioRoot.AddComponent(new BS.BanterAudioSource({ volume: 0.5, loop: false, playOnAwake: false }));
    }

    function setupNetworking() {
        scene.On("space-state-changed", (e) => {
            if (e.detail.changes.some(c => c.property === STATE_KEY)) sync();
        });
        sync();
    }

    async function sync() {
        const raw = scene.spaceState.public[STATE_KEY];
        if (!raw) return;
        gameState = JSON.parse(raw);
        updateVisuals();

        const hardBtnTextObj = await scene.Find("HardModeBtnText");
        if (hardBtnTextObj) {
            const txt = await hardBtnTextObj.GetComponent(BS.CT.BanterText);
            if (txt) txt.text = `HARD MODE: ${gameState.hardMode ? "ON" : "OFF"}`;
        }
    }

    function updateVisuals() {
        tiles.forEach((tile, index) => {
            const colorIdx = Math.floor(seededRandom(gameState.seed + index) * COLORS.length);
            tile.mat.color = COLORS[colorIdx].vec;
            tile.obj.SetActive(gameState.status !== "DROPPED" || colorIdx === gameState.targetColorIndex);
        });
    }

    let lastTick = 0;
    function update() {
        const now = Date.now();
        const remaining = Math.max(0, Math.ceil((gameState.endTime - now) / 1000));

        let displayStr = "";
        let colorVisible = false;
        let colorVec = new BS.Vector4(1, 1, 1, 1);

        if (gameState.status === "SHOWING") {
            displayStr = remaining.toString();
            colorVisible = true;
            colorVec = COLORS[gameState.targetColorIndex].vec;
            if (remaining <= 3 && remaining > 0 && remaining !== lastTick) {
                audio.tick.PlayOneShotFromUrl("https://firer.at/files/tick.mp3");
                lastTick = remaining;
            }
        } else if (gameState.status === "LOBBY") {
            displayStr = "COLOUR DROP";
        } else if (gameState.status === "DROPPED") {
            displayStr = "!!!";
        } else {
            displayStr = "WAIT";
        }

        ui.displays.forEach(d => {
            d.text.text = displayStr;
            d.mat.color = colorVec;
            d.cube.SetActive(colorVisible);
        });

        if (isHost()) driveHostLogic(now);
    }

    function driveHostLogic(now) {
        if (now < gameState.endTime) return;

        if (gameState.status === "LOBBY") {
            // Seed randomized once on game start
            const initialSeed = Math.floor(Math.random() * 999999);
            startNextRound(1, initialSeed);
        } else if (gameState.status === "SHOWING") {
            updateState({ status: "DROPPED", endTime: now + (TIMINGS.DROPPED * 1000) });
        } else if (gameState.status === "DROPPED") {
            // ONLY Change seed if Hard Mode is ENABLED. Triggers as soon as status becomes RESETTING.
            const nextSeed = gameState.hardMode ? Math.floor(Math.random() * 999999) : gameState.seed;
            updateState({
                status: "RESETTING",
                seed: nextSeed,
                endTime: now + (TIMINGS.RESETTING * 1000)
            });
        } else if (gameState.status === "RESETTING") {
            startNextRound(gameState.round + 1, gameState.seed);
        }
    }

    function startNextRound(roundNum, seed) {
        const speedScale = gameState.hardMode ? 0.6 : 0.35;
        const duration = Math.max(1.8, gameState.initialCountdown - (roundNum * speedScale));

        updateState({
            status: "SHOWING",
            round: roundNum,
            seed: seed,
            targetColorIndex: Math.floor(Math.random() * COLORS.length),
            endTime: Date.now() + (duration * 1000)
        });
    }

    function updateState(patch) {
        const next = { ...gameState, ...patch };
        scene.SetPublicSpaceProps({ [STATE_KEY]: JSON.stringify(next) });
    }

    if (window.BS) {
        init();
    } else {
        window.addEventListener("bs-loaded", init);
    }
})();
