(function () {
    let scene;

    // --- Configuration ---
    const STATE_KEY = "colour_drop_game_state";
    const USER_DATA_KEY_PREFIX = "cd_user:";
    const GRID_SIZE = 8;
    const TILE_SIZE = 3;
    const GAME_HEIGHT = 10;
    const LOBBY_POS_RAW = { x: 0, y: 10.1, z: -40 };

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
        initialCountdown: 7,
        activePlayers: 0
    };

    let tiles = [];
    let ui = { root: null, displays: [] };
    let audio = { tick: null };
    let isLocalInArena = false; // Internal tracking using colliders
    let isMuted = false;
    let lastFallTime = 0; // Debounce tracker for falls

    // Leaders
    let scoreboardFalls = null;
    let scoreboardNormal = null;
    let scoreboardHard = null;

    // Local player game session tracking
    let gameStartTime = 0; // Tracks when local player joined the game arena
    let gameModeAtStart = false; // Tracks hardMode state when gameStartTime was set

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
        const root = await new BS.GameObject({ name: "Environment" }).Async();

        // Lobby Floor
        const floor = await new BS.GameObject({ name: "SpectatorLobby", parent: root, localPosition: new BS.Vector3(LOBBY_POS_RAW.x, LOBBY_POS_RAW.y - 0.05, LOBBY_POS_RAW.z) }).Async();
        await floor.AddComponent(new BS.BanterBox({ width: 30, height: 0.5, depth: 30 }));
        await floor.AddComponent(new BS.BoxCollider({ size: new BS.Vector3(30, 0.5, 30) }));
        await floor.AddComponent(new BS.BanterMaterial({ color: new BS.Vector4(0.1, 0.1, 0.1, 1) }));

        // Rules Text (One side of the lobby)
        const rulesObj = await new BS.GameObject({ name: "RulesText", parent: floor, localPosition: new BS.Vector3(-12, 2, 0), localEulerAngles: new BS.Vector3(0, -90, 0) }).Async();
        await rulesObj.AddComponent(new BS.BanterText({
            text: "<size=1.5><b>HOW TO PLAY</b></size>\n\n1. Click <b>JOIN GAME</b> to teleport.\n2. Look at the displays for the <b>TARGET COLOR</b>.\n3. Stand on a matching tile before time runs out.\n4. All other tiles will drop!\n5. Survive as long as you can.\n\n<color=#ffcc00>Hard Mode: Randomizes board every round!</color>",
            fontSize: 0.6,
            color: new BS.Vector4(1, 1, 1, 1),
            horizontalAlignment: BS.HorizontalAlignment.Left
        }));

        // Scoreboard (Other side of the lobby - Split into 3 columns)
        const boardRoot = await new BS.GameObject({ name: "Scoreboards", parent: floor, localPosition: new BS.Vector3(12, 3, 0), localEulerAngles: new BS.Vector3(0, 90, 0) }).Async();

        const createBoard = async (name, x, label) => {
            const obj = await new BS.GameObject({ name: name, parent: boardRoot, localPosition: new BS.Vector3(0, 0, x) }).Async();
            return await obj.AddComponent(new BS.BanterText({
                text: `<b>${label}</b>\n\nWaiting...`,
                fontSize: 0.5,
                color: new BS.Vector4(1, 1, 1, 1),
                horizontalAlignment: BS.HorizontalAlignment.Center
            }));
        };

        scoreboardFalls = await createBoard("FallsBoard", -6, "MOST FALLS");
        scoreboardNormal = await createBoard("NormalBoard", 0, "NORMAL SURVIVAL");
        scoreboardHard = await createBoard("HardBoard", 6, "HARD SURVIVAL");

        // Buttons Container
        const buttonGroup = await new BS.GameObject({ name: "Controls", parent: floor, localPosition: new BS.Vector3(0, 1, 0) }).Async();

        const createBtn = async (name, xPos, color, text, handler) => {
            const btn = await new BS.GameObject({ name: name, parent: buttonGroup, localPosition: new BS.Vector3(xPos, 0, 0) }).Async();
            await btn.AddComponent(new BS.BanterBox({ width: 1, height: 0.4, depth: 0.5 }));
            await btn.AddComponent(new BS.BoxCollider({ size: new BS.Vector3(1, 0.4, 0.5) }));
            await btn.AddComponent(new BS.BanterMaterial({ color: color }));
            btn.SetLayer(5);

            const t = await new BS.GameObject({ name: name + "Text", parent: btn, localPosition: new BS.Vector3(0, 0.5, 0), localEulerAngles: new BS.Vector3(0, 0, 0) }).Async();
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

        await createBtn("HardModeBtn", -6, new BS.Vector4(0.8, 0.1, 0.1, 1), "HARD MODE: OFF", () => {
            if (!isHost()) return;
            updateState({ hardMode: !gameState.hardMode });
        });

        await createBtn("JoinBtn", -3, new BS.Vector4(0, 0.5, 1, 1), "JOIN GAME", () => {
            console.log("Join Game button clicked. Teleporting to arena.");
            scene.TeleportTo(new BS.Vector3(0, GAME_HEIGHT + 2, 0), 0, true);
            gameStartTime = Date.now();
            gameModeAtStart = gameState.hardMode;
            console.log(`Survival timer started. Mode: ${gameModeAtStart ? 'Hard' : 'Normal'}`);

            if (isHost() && gameState.status === "LOBBY") {
                updateState({ status: "RESETTING", endTime: Date.now() + 5000 });
            }
        });

        await createBtn("Timer5Btn", 0, new BS.Vector4(0.1, 0.8, 0.1, 1), "SET: 5S", () => {
            if (!isHost()) return;
            updateState({ initialCountdown: 5 });
        });

        await createBtn("Timer10Btn", 3, new BS.Vector4(0.1, 0.8, 0.1, 1), "SET: 10S", () => {
            if (!isHost()) return;
            updateState({ initialCountdown: 10 });
        });

        await createBtn("MuteBtn", 6, new BS.Vector4(0.5, 0.2, 0.8, 1), "MUTE AUDIO", async (e) => {
            isMuted = !isMuted;
            const btnObj = e.detail.object || await scene.Find("MuteBtn");
            const txt = await btnObj.GetComponent(BS.CT.BanterText) || (await scene.Find("MuteBtnText")).GetComponent(BS.CT.BanterText);
            if (txt) txt.text = isMuted ? "UNMUTE AUDIO" : "MUTE AUDIO";
        });

        await createBtn("ResetBtn", 9, new BS.Vector4(0.5, 0.5, 0.5, 1), "RESET GAME", () => {
            if (!isHost()) return;
            updateState({ status: "LOBBY", round: 0 });
        });

        // Arena Tracker Trigger
        const arenaTracker = await new BS.GameObject({ name: "ArenaTracker", localPosition: new BS.Vector3(0, GAME_HEIGHT + 2, 0) }).Async();
        await arenaTracker.AddComponent(new BS.BoxCollider({ isTrigger: true, size: new BS.Vector3(GRID_SIZE * TILE_SIZE, 5, GRID_SIZE * TILE_SIZE) }));
        await arenaTracker.AddComponent(new BS.BanterColliderEvents());
        arenaTracker.On("trigger-enter", (e) => {
            if (e.detail.user && e.detail.user.isLocal) {
                console.log("Local player entered ARENA zone.");
                isLocalInArena = true;
                if (isHost() && gameState.status === "LOBBY") {
                    updateState({ status: "RESETTING", endTime: Date.now() + 5000 });
                }
            }
        });
        arenaTracker.On("trigger-exit", (e) => {
            if (e.detail.user && e.detail.user.isLocal) {
                console.log("Local player left ARENA zone.");
                isLocalInArena = false;
            }
        });

        // Death Zone
        const deadZone = await new BS.GameObject({ name: "DeadZone", localPosition: new BS.Vector3(0, GAME_HEIGHT - 3, 0) }).Async();
        await deadZone.AddComponent(new BS.BoxCollider({ isTrigger: true, size: new BS.Vector3(100, 2, 100) }));
        await deadZone.AddComponent(new BS.BanterColliderEvents());
        deadZone.On("trigger-enter", (e) => {
            if (e.detail.user && e.detail.user.isLocal) {
                console.log("Local player entered DeadZone.");

                const now = Date.now();
                if (now - lastFallTime > 1000) { // 1 second debounce
                    lastFallTime = now;
                    console.log("Local player fell! Processing score and teleporting to lobby.");

                    updateUserStats(gameStartTime > 0 ? now - gameStartTime : 0, gameModeAtStart);
                    gameStartTime = 0; // Reset for next session

                    scene.TeleportTo(new BS.Vector3(LOBBY_POS_RAW.x, LOBBY_POS_RAW.y, LOBBY_POS_RAW.z), 0, true);
                } else {
                    console.log("Fall detected but ignored due to debounce.");
                }
            }
        });
    }

    async function buildGrid() {
        const gridRoot = await new BS.GameObject({ name: "GridRoot", localPosition: new BS.Vector3(0, GAME_HEIGHT, 0) }).Async();
        const offset = (GRID_SIZE * TILE_SIZE) / 2 - (TILE_SIZE / 2);

        for (let x = 0; x < GRID_SIZE; x++) {
            for (let z = 0; z < GRID_SIZE; z++) {
                const tileName = `Tile_${x}_${z}`;
                const tile = await new BS.GameObject({
                    name: tileName,
                    parent: gridRoot,
                    localPosition: new BS.Vector3(x * TILE_SIZE - offset, 0, z * TILE_SIZE - offset)
                }).Async();
                await tile.AddComponent(new BS.BanterBox({ width: TILE_SIZE - 0.1, height: 0.4, depth: TILE_SIZE - 0.1 }));
                await tile.AddComponent(new BS.BoxCollider({ size: new BS.Vector3(TILE_SIZE - 0.1, 0.4, TILE_SIZE - 0.1) }));
                const mat = await tile.AddComponent(new BS.BanterMaterial("Unlit/Diffuse", "", new BS.Vector4(1, 1, 1, 1), BS.MaterialSide.Front, false, tileName));
                tiles.push({ obj: tile, mat: mat, x: x, z: z });
            }
        }
    }

    async function setupUI() {
        const uiAnchor = await new BS.GameObject({ name: "UIAnchor", localPosition: new BS.Vector3(0, GAME_HEIGHT + 12, 0) }).Async();
        ui.root = uiAnchor;

        const createDisplay = async (name, pos, rot) => {
            const panel = await new BS.GameObject({ name: name, parent: uiAnchor, localPosition: pos, localEulerAngles: rot }).Async();
            const textObj = await new BS.GameObject({ name: "Label", parent: panel, localPosition: new BS.Vector3(0, 4, 0) }).Async();
            const textComp = await textObj.AddComponent(new BS.BanterText({ text: "COLOUR DROP", fontSize: 12, color: new BS.Vector4(1, 1, 1, 1), horizontalAlignment: BS.HorizontalAlignment.Center }));
            const cube = await new BS.GameObject({ name: "ColorCube", parent: panel, localPosition: new BS.Vector3(0, -1, 0) }).Async();
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
        const audioRoot = await new BS.GameObject({ name: "Audio" }).Async();
        audio.tick = await audioRoot.AddComponent(new BS.BanterAudioSource({ volume: 0.3, loop: false, playOnAwake: false }));
    }

    function setupNetworking() {
        scene.On("space-state-changed", (e) => {
            if (e.detail.changes.some(c => c.property === STATE_KEY)) sync();
            updateScoreboard();
        });
        sync();
        updateScoreboard();
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

    function updateScoreboard() {
        if (!scoreboardFalls || !scoreboardNormal || !scoreboardHard) return;

        const state = scene.spaceState.public;
        const players = [];

        Object.keys(state).forEach(key => {
            if (key.startsWith(USER_DATA_KEY_PREFIX)) {
                try { players.push(JSON.parse(state[key])); } catch (e) { }
            }
        });

        const updateBoard = (comp, title, sorted, formatter) => {
            let str = `<size=1.2><b>${title}</b></size>\n\n`;
            if (sorted.length === 0) str += "No records yet!";
            else sorted.forEach((p, i) => str += `${i+1}. ${p.name}: ${formatter(p)}\n`);
            comp.text = str;
        };

        const topFalls = [...players].sort((a, b) => b.falls - a.falls).slice(0, 10);
        const topNormal = [...players].filter(p => p.bestNormal > 0).sort((a, b) => b.bestNormal - a.bestNormal).slice(0, 10);
        const topHard = [...players].filter(p => p.bestHard > 0).sort((a, b) => b.bestHard - a.bestHard).slice(0, 10);

        updateBoard(scoreboardFalls, "MOST FALLS", topFalls, p => p.falls);
        updateBoard(scoreboardNormal, "BEST NORMAL", topNormal, p => (p.bestNormal / 1000).toFixed(1) + "s");
        updateBoard(scoreboardHard, "BEST HARD", topHard, p => (p.bestHard / 1000).toFixed(1) + "s");
    }

    function updateUserStats(survivalTime, modeAtStart) {
        const uid = scene.localUser.uid;
        const key = USER_DATA_KEY_PREFIX + uid;
        const currentDataRaw = scene.spaceState.public[key];

        let stats = {
            uid: uid,
            name: scene.localUser.name.replace(/<[^>]*>/g, ''),
            falls: 0,
            bestNormal: 0,
            bestHard: 0
        };

        if (currentDataRaw) {
            try { stats = JSON.parse(currentDataRaw); } catch (e) { }
        }

        stats.falls++;
        stats.name = scene.localUser.name.replace(/<[^>]*>/g, '');

        if (survivalTime > 0) {
            if (modeAtStart) {
                if (survivalTime > stats.bestHard) stats.bestHard = survivalTime;
            } else {
                if (survivalTime > stats.bestNormal) stats.bestNormal = survivalTime;
            }
        }

        scene.SetPublicSpaceProps({ [key]: JSON.stringify(stats) });
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
            if (!isMuted && remaining <= 3 && remaining > 0 && remaining !== lastTick) {
                audio.tick.PlayOneShotFromUrl("https://audiofiles.firer.at/mp3/Tick.mp3");
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
            // Wait
        } else if (gameState.status === "SHOWING") {
            updateState({ status: "DROPPED", endTime: now + (TIMINGS.DROPPED * 1000) });
        } else if (gameState.status === "DROPPED") {
            const nextSeed = gameState.hardMode ? Math.floor(Math.random() * 999999) : gameState.seed;
            updateState({ status: "RESETTING", seed: nextSeed, endTime: now + (TIMINGS.RESETTING * 1000) });
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

    if (window.BS) init();
    else window.addEventListener("bs-loaded", init);
})();
