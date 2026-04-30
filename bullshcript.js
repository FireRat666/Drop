(function () {
    let scene;

    // --- Configuration ---
    const STATE_KEY = "drop_game_state";
    const USER_DATA_KEY_PREFIX = "cd_user:";
    let GRID_SIZE = 8;
    let TILE_SIZE = 3;
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
        DROPPED: 2,
        RESETTING: 3,
        HOST_STEAL_DURATION: 30000
    };

    // --- State Variables ---
    let gameState = {
        status: "LOBBY",
        round: 0,
        targetColorIndex: 0,
        seed: 0,
        endTime: 0,
        hardMode: false,
        gridMode: 'normal',
        initialCountdown: 7,
        activePlayersList: [],
        initialPlayersCount: 0,
        gameId: 0,
        winnerUid: null,
        currentHostUid: null,
        hostStealStartTime: 0,
        hostStealRequesterUid: null
    };

    let lastProcessedGameId = 0;

    let tiles = [];
    let ui = { root: null, displays: [] };
    let audio = { tick: null };
    let isLocalInArena = false;
    let isMuted = false;
    let lastFallTime = 0;
    let isResettingSmoothly = false;
    let lastHostActionTime = 0;
    let lastHostState = null;
    let lastHostUid = null;
    let visibilityInitialized = false;

    // UI State
    let uiState = {
        leaderboardTab: 'falls', // 'falls', 'normal', 'hard'
        leaderboardSizeFilter: 'normal', // 'normal', 'small'
        leaderboardPage: 0,
        playersPerPage: 10
    };

    let uiElements = {
        muteBtn: null,
        timerBtn: null,
        hardModeBtn: null,
        boardSizeBtn: null,
        hostDisplay: null,
        leaderboardContent: null,
        leaderboardPageInfo: null,
        sizeFilterBtn: null,
        hostOnlyButtons: [],
        tabs: {},
        hostControlsObj: null,
        hostRoot: null
    };

    let currentGridMode = 'normal';
    let environmentElements = {
        arenaTracker: null,
        landingCollider: null,
        gridRoot: null
    };

    // Local player game session tracking
    let gameStartTime = 0;
    let gameModeAtStart = false;
    let gameGridModeAtStart = 'normal';

    // --- Utils ---
    const seededRandom = (seed) => {
        const x = Math.sin(seed) * 10000;
        return x - Math.floor(x);
    };

    const isHost = () => {
        if (!scene || !scene.localUser) return false;
        if (!gameState.currentHostUid) {
            const uids = Object.keys(scene.users || {}).sort();
            return uids.length > 0 && uids[0] === scene.localUser.uid;
        }
        return gameState.currentHostUid === scene.localUser.uid;
    };

    // --- Initialization ---
    async function init() {
        if (scene) return;
        scene = BS.BanterScene.GetInstance();

        console.log("DROP GAME: BS Ready. Building Environment...");

        const settings = new BS.SceneSettings();
        settings.EnableTeleport = false;
        settings.EnableJump = true;
        settings.MaxOccupancy = 30;
        settings.RefreshRate = 90;
        settings.EnableHandHold = false;
        settings.ClippingPlane = new BS.Vector2(0.05, 500);
        settings.SpawnPoint = new BS.Vector4(LOBBY_POS_RAW.x, LOBBY_POS_RAW.y, LOBBY_POS_RAW.z, 0);
        settings.PhysicsSettingsLocked = true;
        settings.SettingsLocked = true;
        scene.SetSettings(settings);

        COLORS = COLORS.map(c => ({ ...c, vec: new BS.Vector4(c.vec[0], c.vec[1], c.vec[2], c.vec[3]) }));

        await buildEnvironment();
        await buildGrid();
        await setupUI();
        await setupAudio();
        await createPerformantAnimatedSkybox();

        if (!scene.unityLoaded) {
            console.log("DROP GAME: Waiting for Unity...");
            await new Promise(resolve => {
                scene.On("unity-loaded", resolve);
                window.addEventListener("unity-loaded", resolve, { once: true });
            });
        }
        console.log("DROP GAME: Unity Loaded!");

        scene.TeleportTo(new BS.Vector3(LOBBY_POS_RAW.x, LOBBY_POS_RAW.y, LOBBY_POS_RAW.z), 0, true);
        setupNetworking();
        setInterval(update, 100);
        console.log("DROP GAME: Init Complete");
    }

    async function buildEnvironment() {
        const root = await new BS.GameObject({ name: "Environment" }).Async();

        // Lobby Floor
        const floor = await new BS.GameObject({ name: "SpectatorLobby", parent: root, localPosition: new BS.Vector3(LOBBY_POS_RAW.x, LOBBY_POS_RAW.y - 0.05, LOBBY_POS_RAW.z) }).Async();
        await floor.AddComponent(new BS.BanterBox({ width: 30, height: 0.5, depth: 30 }));
        await floor.AddComponent(new BS.BoxCollider({ size: new BS.Vector3(30, 0.5, 30) }));
        await floor.AddComponent(new BS.BanterMaterial({ shaderName: "Standard", color: new BS.Vector4(0.1, 0.1, 0.1, 1) }));

        // Host Display above the controls
        const hostObj = await new BS.GameObject({ name: "HostDisplay", parent: floor, localPosition: new BS.Vector3(0, 3.5, 12), localEulerAngles: new BS.Vector3(0, 0, 0) }).Async();
        uiElements.hostDisplay = await hostObj.AddComponent(new BS.BanterText({
            text: "Waiting for Unity...",
            fontSize: 5,
            color: new BS.Vector4(1, 1, 0, 1),
            horizontalAlignment: BS.HorizontalAlignment.Center
        }));

        await buildRulesUI(floor);
        await buildControlsUI(floor);
        await buildLeaderboardUI(floor);

        // Arena Tracker
        const arenaTracker = await new BS.GameObject({ name: "ArenaTracker", localPosition: new BS.Vector3(0, GAME_HEIGHT + 2, 0) }).Async();
        environmentElements.arenaTracker = arenaTracker;
        await arenaTracker.AddComponent(new BS.BoxCollider({ isTrigger: true, size: new BS.Vector3(GRID_SIZE * TILE_SIZE, 5, GRID_SIZE * TILE_SIZE) }));
        await arenaTracker.AddComponent(new BS.BanterColliderEvents());
        arenaTracker.On("trigger-enter", (e) => {
            if (e.detail.user && e.detail.user.isLocal) {
                isLocalInArena = true;
                if (gameState.status === "LOBBY") updateState({ status: "RESETTING", endTime: Date.now() + 5000 });
            }
        });
        arenaTracker.On("trigger-exit", (e) => {
            if (e.detail.user && e.detail.user.isLocal) isLocalInArena = false;
            if (isHost() && e.detail.user) {
                removePlayerFromActive(e.detail.user.uid);
            }
        });

        // Death Zone
        const deadZone = await new BS.GameObject({ name: "DeadZone", localPosition: new BS.Vector3(0, GAME_HEIGHT - 3, 0) }).Async();
        await deadZone.AddComponent(new BS.BoxCollider({ isTrigger: true, size: new BS.Vector3(100, 2, 100) }));
        await deadZone.AddComponent(new BS.BanterColliderEvents());
        deadZone.On("trigger-enter", (e) => {
            if (e.detail.user && e.detail.user.isLocal) {
                const now = Date.now();
                if (now - lastFallTime > 1000) {
                    lastFallTime = now;
                    updateUserStats(gameStartTime > 0 ? now - gameStartTime : 0, gameModeAtStart);
                    gameStartTime = 0;
                    scene.TeleportTo(new BS.Vector3(LOBBY_POS_RAW.x, LOBBY_POS_RAW.y, LOBBY_POS_RAW.z), 0, true);
                }
            }
            if (isHost() && e.detail.user) {
                removePlayerFromActive(e.detail.user.uid);
            }
        });

        // Invisible Landing Collider
        const landingCollider = await new BS.GameObject({ name: "LandingCollider", localPosition: new BS.Vector3(0, GAME_HEIGHT - 10, 0) }).Async();
        environmentElements.landingCollider = landingCollider;
        await landingCollider.AddComponent(new BS.BoxCollider({ size: new BS.Vector3(GRID_SIZE * TILE_SIZE, 0.5, GRID_SIZE * TILE_SIZE) }));
        // await landingCollider.AddComponent(new BS.BanterMaterial({ shaderName: "Standard", color: new BS.Vector4(1, 1, 1, 1) }));
    }

    async function buildRulesUI(parent) {
        const rulesObj = await new BS.GameObject({ 
            name: "RulesUI", 
            parent: parent, 
            localPosition: new BS.Vector3(-12, 2.7, 0), 
            localEulerAngles: new BS.Vector3(0, -90, 0) 
        }).Async();
        
        const panel = await rulesObj.AddComponent(new BS.BanterUI(new BS.Vector2(630, 410), false));
        const root = panel.CreateVisualElement();
        await root.Async();
        root.SetStyles({
            width: '100%',
            height: '100%',
            backgroundColor: '#1a1c29',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            paddingTop: '20px',
            paddingRight: '20px',
            paddingBottom: '20px',
            paddingLeft: '20px',
            borderTopLeftRadius: '10px',
            borderTopRightRadius: '10px',
            borderBottomRightRadius: '10px',
            borderBottomLeftRadius: '10px'
        });

        const title = panel.CreateLabel(undefined, root);
        await title.Async();
        title.text = 'HOW TO PLAY';
        title.SetStyles({
            fontSize: '28px',
            alignItems: 'center',
            color: '#ffcc00',
            backgroundColor: 'rgba(0,0,0,0)',
            marginBottom: '16px',
            unityFontStyleAndWeight: 'bold' // Though unity* props were warned about, Banter docs sometimes use them. If it breaks, we remove it. Wait, the user specifically said: "Never use unity* properties — all cause SetStyles to abort." So we omit it!
        });
        
        // Remove unityFontStyleAndWeight
        title.SetStyles({
            fontSize: '28px',
            textAlign: 'center',
            color: '#ffcc00',
            backgroundColor: 'rgba(0,0,0,0)',
            marginBottom: '16px'
        });

        const body = panel.CreateLabel(undefined, root);
        await body.Async();
        body.text = "1. The Host clicks START GAME to teleport everyone into the arena.\n2. Look at the displays for the TARGET COLOR.\n3. Stand on a matching tile before time runs out.\n4. All other tiles will drop!\n5. Survive as long as you can.\n6. Timer get's shorter each round.\n\nHOST CONTROLS:\n- Claim Host: Take control of game settings. Anyone can claim.\n- Tile Size: Switch between an 8x8 or 12x12 grid (lobby only).\n- Initial Timer: Set the first round's duration (10s, 7s, or 5s).\n- Hard Mode: Randomizes the board colors every round!\n- Reset: End the current game and return to the lobby.";
        body.SetStyles({
            fontSize: '18px',
            textAlign: 'center',
            color: '#ffffff',
            backgroundColor: 'rgba(0,0,0,0)',
            whiteSpace: 'normal'
        });
    }

    async function buildControlsUI(parent) {
        const userControlsObj = await new BS.GameObject({ 
            name: "UserControlsUI", 
            parent: parent, 
            localPosition: new BS.Vector3(0, 1.1, 3), 
            localEulerAngles: new BS.Vector3(0, 0, 0) 
        }).Async();

        const userPanel = await userControlsObj.AddComponent(new BS.BanterUI(new BS.Vector2(320, 90), false));
        const userRoot = userPanel.CreateVisualElement();
        await userRoot.Async();
        userRoot.SetStyles({
            width: '100%', height: '100%', backgroundColor: '#1a1c29', display: 'flex', flexDirection: 'row',
            alignItems: 'center', justifyContent: 'center', padding: '20px', borderRadius: '10px'
        });

        const createUIButton = async (panelRef, rootRef, text, color, isHostOnly, handler) => {
            const btn = panelRef.CreateButton(rootRef);
            await btn.Async();
            btn.text = text;
            btn.SetStyles({ 
                height: '60px', fontSize: '18px', backgroundColor: color, color: '#ffffff',
                marginRight: '10px', paddingTop: '0px', paddingRight: '15px', paddingBottom: '0px', paddingLeft: '15px'
            });
            btn.OnClick(() => {
                btn.SetStyles({ backgroundColor: '#555555' });
                setTimeout(() => btn.SetStyles({ backgroundColor: color }), 150);
                handler();
            });
            if (isHostOnly) {
                uiElements.hostOnlyButtons.push(btn);
            }
            return btn;
        };

        await createUIButton(userPanel, userRoot, "CLAIM HOST", '#e69900', false, () => {
            const hostPresent = gameState.currentHostUid && scene.users[gameState.currentHostUid];
            const now = Date.now();
            if (!hostPresent) {
                updateState({ currentHostUid: scene.localUser.uid, hostStealStartTime: 0, hostStealRequesterUid: null });
            } else if (gameState.currentHostUid === scene.localUser.uid) {
                updateState({ hostStealStartTime: 0, hostStealRequesterUid: null });
            } else {
                updateState({ hostStealStartTime: now, hostStealRequesterUid: scene.localUser.uid });
            }
        });

        uiElements.muteBtn = await createUIButton(userPanel, userRoot, "MUTED\nFalse", '#8033cc', false, () => {
            isMuted = !isMuted;
            uiElements.muteBtn.text = isMuted ? "MUTED\nTrue" : "MUTED\nFalse";
        });

        const hostControlsObj = await new BS.GameObject({ 
            name: "HostControlsUI", 
            parent: parent, 
            localPosition: new BS.Vector3(0, 2.1, 3), 
            localEulerAngles: new BS.Vector3(0, 0, 0) 
        }).Async();
        uiElements.hostControlsObj = hostControlsObj;

        const hostPanel = await hostControlsObj.AddComponent(new BS.BanterUI(new BS.Vector2(750, 90), false));
        const hostRoot = hostPanel.CreateVisualElement();
        await hostRoot.Async();
        hostRoot.SetStyles({
            width: '100%', height: '100%', backgroundColor: '#1a1c29', display: 'flex', flexDirection: 'row',
            alignItems: 'center', justifyContent: 'center', padding: '20px', borderRadius: '10px'
        });
        uiElements.hostRoot = hostRoot;

        uiElements.hardModeBtn = await createUIButton(hostPanel, hostRoot, "HARD MODE", '#cc1111', true, () => {
            if (!isHost()) return;
            updateState({ hardMode: !gameState.hardMode });
        });

        uiElements.boardSizeBtn = await createUIButton(hostPanel, hostRoot, "TILE SIZE\nNORMAL", '#1180cc', true, () => {
            if (!isHost() || gameState.status !== "LOBBY") return;
            updateState({ gridMode: gameState.gridMode === 'normal' ? 'small' : 'normal' });
        });

        uiElements.timerBtn = await createUIButton(hostPanel, hostRoot, "INITIAL TIMER\n7S", '#1a801a', true, () => {
            if (!isHost()) return;
            let next = 10;
            if (gameState.initialCountdown === 10) next = 7;
            else if (gameState.initialCountdown === 7) next = 5;
            else next = 10;
            updateState({ initialCountdown: next });
        });

        await createUIButton(hostPanel, hostRoot, "START GAME", '#0080ff', true, () => {
            if (!isHost()) return;
            if (gameState.status === "LOBBY" || gameState.status === "WINNER") {
                const uids = Object.keys(scene.users || {});
                updateState({ 
                    status: "RESETTING", 
                    endTime: Date.now() + 8000,
                    activePlayersList: uids,
                    initialPlayersCount: uids.length,
                    gameId: Date.now(),
                    winnerUid: null
                });
            }
        });

        await createUIButton(hostPanel, hostRoot, "RESET", '#808080', true, () => {
            if (!isHost()) return;
            updateState({ status: "LOBBY", round: 0, winnerUid: null });
        });
    }

    async function buildLeaderboardUI(parent) {
        const boardObj = await new BS.GameObject({ 
            name: "LeaderboardUI", 
            parent: parent, 
            localPosition: new BS.Vector3(12, 2.5, 0), 
            localEulerAngles: new BS.Vector3(0, 90, 0) 
        }).Async();

        const panel = await boardObj.AddComponent(new BS.BanterUI(new BS.Vector2(500, 450), false));
        const root = panel.CreateVisualElement();
        await root.Async();
        root.SetStyles({
            width: '100%',
            height: '100%',
            backgroundColor: '#1a1c29',
            display: 'flex',
            flexDirection: 'column',
            paddingTop: '20px',
            paddingRight: '20px',
            paddingBottom: '20px',
            paddingLeft: '20px',
            borderTopLeftRadius: '10px',
            borderTopRightRadius: '10px',
            borderBottomRightRadius: '10px',
            borderBottomLeftRadius: '10px'
        });

        // Tabs Row
        const tabsRow = panel.CreateVisualElement(root);
        await tabsRow.Async();
        tabsRow.SetStyles({
            display: 'flex',
            flexDirection: 'row',
            justifyContent: 'space-between',
            marginBottom: '20px'
        });

        const createTabBtn = async (id, text) => {
            const btn = panel.CreateButton(tabsRow);
            await btn.Async();
            btn.text = text;
            btn.SetStyles({
                height: '40px',
                fontSize: '14px',
                backgroundColor: id === uiState.leaderboardTab ? '#0080ff' : '#333333',
                color: '#ffffff',
                marginRight: '10px',
                paddingTop: '0px',
                paddingRight: '10px',
                paddingBottom: '0px',
                paddingLeft: '10px'
            });
            uiElements.tabs[id] = btn;

            btn.OnClick(() => {
                uiState.leaderboardTab = id;
                uiState.leaderboardPage = 0;
                
                // Update tab colors
                Object.keys(uiElements.tabs).forEach(tabId => {
                    uiElements.tabs[tabId].SetStyles({
                        backgroundColor: tabId === id ? '#0080ff' : '#333333'
                    });
                });

                if (uiElements.sizeFilterBtn) {
                    uiElements.sizeFilterBtn.SetStyles({ display: id === 'falls' ? 'none' : 'flex' });
                }

                updateScoreboard();
            });
            return btn;
        };

        await createTabBtn('falls', 'MOST FALLS');
        await createTabBtn('normal', 'NORMAL SURVIVAL');
        await createTabBtn('hard', 'HARD SURVIVAL');

        // Content Area
        const contentArea = panel.CreateVisualElement(root);
        await contentArea.Async();
        contentArea.SetStyles({
            display: 'flex',
            flexDirection: 'column',
            flexGrow: '1',
            backgroundColor: '#0d0f17',
            paddingTop: '10px',
            paddingRight: '10px',
            paddingBottom: '10px',
            paddingLeft: '10px',
            marginBottom: '20px'
        });

        uiElements.leaderboardContent = panel.CreateLabel(undefined, contentArea);
        await uiElements.leaderboardContent.Async();
        uiElements.leaderboardContent.text = "Loading...";
        uiElements.leaderboardContent.SetStyles({
            fontSize: '18px',
            color: '#ffffff',
            backgroundColor: 'rgba(0,0,0,0)'
        });

        // Size Filter Button (only for Normal/Hard)
        uiElements.sizeFilterBtn = panel.CreateButton(contentArea);
        await uiElements.sizeFilterBtn.Async();
        uiElements.sizeFilterBtn.text = "FILTER: 8x8 (NORMAL)";
        uiElements.sizeFilterBtn.SetStyles({
            height: '30px',
            fontSize: '14px',
            backgroundColor: '#444444',
            color: '#ffffff',
            marginTop: '10px',
            display: 'none' // Hidden by default (falls tab)
        });
        uiElements.sizeFilterBtn.OnClick(() => {
            uiState.leaderboardSizeFilter = uiState.leaderboardSizeFilter === 'normal' ? 'small' : 'normal';
            uiElements.sizeFilterBtn.text = uiState.leaderboardSizeFilter === 'normal' ? "FILTER: 8x8" : "FILTER: 12x12";
            uiState.leaderboardPage = 0;
            updateScoreboard();
        });

        // Pagination Row
        const pageRow = panel.CreateVisualElement(root);
        await pageRow.Async();
        pageRow.SetStyles({
            display: 'flex',
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center'
        });

        const prevBtn = panel.CreateButton(pageRow);
        await prevBtn.Async();
        prevBtn.text = "< PREV";
        prevBtn.SetStyles({ height: '40px', fontSize: '16px', backgroundColor: '#333333', color: '#ffffff' });
        prevBtn.OnClick(() => {
            if (uiState.leaderboardPage > 0) {
                uiState.leaderboardPage--;
                updateScoreboard();
            }
        });

        uiElements.leaderboardPageInfo = panel.CreateLabel(undefined, pageRow);
        await uiElements.leaderboardPageInfo.Async();
        uiElements.leaderboardPageInfo.text = "Page 1";
        uiElements.leaderboardPageInfo.SetStyles({
            fontSize: '16px',
            color: '#cccccc',
            backgroundColor: 'rgba(0,0,0,0)'
        });

        const nextBtn = panel.CreateButton(pageRow);
        await nextBtn.Async();
        nextBtn.text = "NEXT >";
        nextBtn.SetStyles({ height: '40px', fontSize: '16px', backgroundColor: '#333333', color: '#ffffff' });
        nextBtn.OnClick(() => {
            uiState.leaderboardPage++;
            updateScoreboard();
        });
    }

    async function buildGrid() {
        if (environmentElements.gridRoot) {
            environmentElements.gridRoot.Destroy();
        }
        const gridRoot = await new BS.GameObject({ name: "GridRoot", localPosition: new BS.Vector3(0, GAME_HEIGHT, 0) }).Async();
        environmentElements.gridRoot = gridRoot;
        const offset = (GRID_SIZE * TILE_SIZE) / 2 - (TILE_SIZE / 2);
        const tilePromises = [];

        for (let x = 0; x < GRID_SIZE; x++) {
            for (let z = 0; z < GRID_SIZE; z++) {
                tilePromises.push((async (lx, lz) => {
                    const initialWorldPos = { x: lx * TILE_SIZE - offset, y: GAME_HEIGHT, z: lz * TILE_SIZE - offset };
                    const initialRotation = { x: 0, y: 0, z: 0, w: 1 };
                    const tile = await new BS.GameObject({
                        name: `Tile_${lx}_${lz}`, parent: gridRoot,
                        localPosition: new BS.Vector3(lx * TILE_SIZE - offset, 0, lz * TILE_SIZE - offset)
                    }).Async();
                    await tile.AddComponent(new BS.BanterBox({ width: TILE_SIZE - 0.1, height: 0.4, depth: TILE_SIZE - 0.1 }));
                    await tile.AddComponent(new BS.BoxCollider({ size: new BS.Vector3(TILE_SIZE - 0.1, 0.4, TILE_SIZE - 0.1) }));
                    const mat = await tile.AddComponent(new BS.BanterMaterial("Standard", "", new BS.Vector4(1, 1, 1, 1), BS.MaterialSide.Front, false, `Tile_${lx}_${lz}`));
                    const rb = await tile.AddComponent(new BS.BanterRigidbody({
                        useGravity: true,
                        isKinematic: true,
                        freezePositionX: true,
                        freezePositionZ: true,
                        freezeRotationX: true,
                        freezeRotationY: true,
                        freezeRotationZ: true
                    }));
                    tiles.push({ obj: tile, mat: mat, rb: rb, x: lx, z: lz, initialWorldPos: initialWorldPos, initialRotation: initialRotation });
                })(x, z));
            }
        }
        await Promise.all(tilePromises);
    }

    async function setupUI() {
        const uiAnchor = await new BS.GameObject({ name: "UIAnchor", localPosition: new BS.Vector3(0, GAME_HEIGHT + 12, 0) }).Async();
        const createDisplay = async (name, pos, rot) => {
            const panel = await new BS.GameObject({ name: name, parent: uiAnchor, localPosition: pos, localEulerAngles: rot }).Async();
            const textObj = await new BS.GameObject({ name: "Label", parent: panel, localPosition: new BS.Vector3(0, 0, 0) }).Async();
            const textComp = await textObj.AddComponent(new BS.BanterText({ text: "DROP GAME", fontSize: 12, color: new BS.Vector4(1, 1, 1, 1), horizontalAlignment: BS.HorizontalAlignment.Center }));
            const cube = await new BS.GameObject({ name: "ColorCube", parent: panel, localPosition: new BS.Vector3(0, -5, 0) }).Async();
            await cube.AddComponent(new BS.BanterPlane({ width: 15, height: 5 }));
            const mat = await cube.AddComponent(new BS.BanterMaterial({ shaderName: "Standard", color: new BS.Vector4(1, 1, 1, 1) }));
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
        scene.On("user-left", (e) => {
            if (e.detail.uid === gameState.currentHostUid) {
                const uids = Object.keys(scene.users).filter(id => id !== e.detail.uid).sort();
                if (uids.length > 0 && uids[0] === scene.localUser.uid) {
                    updateState({ currentHostUid: scene.localUser.uid, hostStealStartTime: 0, hostStealRequesterUid: null });
                }
            }
            if (isHost()) {
                if (e.detail.uid === gameState.hostStealRequesterUid) {
                    updateState({ hostStealStartTime: 0, hostStealRequesterUid: null });
                }
                removePlayerFromActive(e.detail.uid);
            }
        });
        sync();
        updateScoreboard();
    }

    async function sync() {
        const raw = scene.spaceState.public[STATE_KEY];
        if (!raw) return;
        gameState = JSON.parse(raw);
        updateVisuals();

        if (gameState.gridMode && gameState.gridMode !== currentGridMode) {
            currentGridMode = gameState.gridMode;
            if (currentGridMode === 'small') {
                GRID_SIZE = 12;
                TILE_SIZE = 2;
            } else {
                GRID_SIZE = 8;
                TILE_SIZE = 3;
            }

            tiles.forEach(t => t.obj.Destroy());
            tiles = [];
            await buildGrid();

            const newSize = GRID_SIZE * TILE_SIZE;
            if (environmentElements.arenaTracker) {
                const col = await environmentElements.arenaTracker.GetComponent(BS.CT.BoxCollider);
                if (col) col.size = new BS.Vector3(newSize, 5, newSize);
            }
            if (environmentElements.landingCollider) {
                const col = await environmentElements.landingCollider.GetComponent(BS.CT.BoxCollider);
                if (col) col.size = new BS.Vector3(newSize, 0.5, newSize);
            }
        }

        if (uiElements.boardSizeBtn) {
            const isLobby = gameState.status === 'LOBBY';
            const sizeStr = gameState.gridMode === 'small' ? '12x12' : '8x8';
            uiElements.boardSizeBtn.text = isLobby ? `TILE SIZE\n${sizeStr}` : `TILE SIZE\n${sizeStr}\n<size=10>(LOBBY ONLY)</size>`;
            uiElements.boardSizeBtn.SetStyles({
                backgroundColor: isLobby ? '#1180cc' : '#444444'
            });
        }

        if (uiElements.hardModeBtn) {
            uiElements.hardModeBtn.text = `HARD MODE\n${gameState.hardMode ? "ON" : "OFF"}`;
        }

        if (uiElements.timerBtn) {
            uiElements.timerBtn.text = `INITIAL TIMER\n${gameState.initialCountdown}S`;
        }

        updateButtonVisibility();

        if (gameState.gameId && gameState.gameId !== lastProcessedGameId) {
            lastProcessedGameId = gameState.gameId;
            if (gameState.activePlayersList && gameState.activePlayersList.includes(scene.localUser.uid)) {
                const rx = (Math.random() * 6) - 3;
                const rz = (Math.random() * 6) - 3;
                scene.TeleportTo(new BS.Vector3(rx, GAME_HEIGHT + 2, rz), 0, true);
            }
        }
    }

    function updateButtonVisibility() {
        const userIsHost = isHost();
        const currentHostUid = gameState.currentHostUid;
        
        const hasControls = !!uiElements.hostControlsObj;
        const hasRoot = !!uiElements.hostRoot;

        if (visibilityInitialized && userIsHost === lastHostState && currentHostUid === lastHostUid) return;
        
        if (hasControls && hasRoot) {
            visibilityInitialized = true;
        }

        console.log(`DROP GAME: Host change detected. UserIsHost: ${userIsHost}, HostUid: ${currentHostUid}, HasControls: ${hasControls}, HasRoot: ${hasRoot}`);
        lastHostState = userIsHost;
        lastHostUid = currentHostUid;

        if (uiElements.hostControlsObj) {
            const trans = uiElements.hostControlsObj.GetComponent(BS.CT.Transform);
            if (trans) {
                // Moving and scaling is often more reliable than SetActive for world-aligned Screen UIs
                if (userIsHost) {
                    trans.localPosition = new BS.Vector3(0, 2.1, 3);
                    trans.localScale = new BS.Vector3(1, 1, 1);
                } else {
                    trans.localPosition = new BS.Vector3(0, -100, 0);
                    trans.localScale = new BS.Vector3(0, 0, 0);
                }
            }
        }
        
        if (uiElements.hostRoot) {
            uiElements.hostRoot.SetStyles({ display: userIsHost ? 'flex' : 'none' });
        }
    }

    function startSmoothReset() {
        if (isResettingSmoothly) return;
        isResettingSmoothly = true;

        const duration = 1500;
        const startTime = Date.now();

        tiles.forEach((tile, index) => {
            // Check if this tile was dropped before we reset its kinematic state
            const didDrop = tile.rb.isKinematic === false;
            
            tile.rb.isKinematic = true;
            tile.rb.velocity = new BS.Vector3(0, 0, 0);
            tile.rb.angularVelocity = new BS.Vector3(0, 0, 0);

            const p = tile.obj.transform.position;
            const r = tile.obj.transform.rotation;
            
            // To reliably target tiles from the *previous* round that fell without being affected 
            // by the newly randomized seed, we identify them by their drop state.
            tile.needsReset = didDrop;
            
            if (tile.needsReset) {
                tile.resetStartPos = { x: p.x, y: p.y, z: p.z };
                tile.resetStartRot = { x: r.x, y: r.y, z: r.z, w: r.w };
            }
        });

        const animate = () => {
            const elapsed = Date.now() - startTime;
            const t = Math.min(1, elapsed / duration);

            tiles.forEach(tile => {
                if (!tile.needsReset || !tile.resetStartPos || !tile.initialWorldPos) return;

                const px = tile.resetStartPos.x + (tile.initialWorldPos.x - tile.resetStartPos.x) * t;
                const py = tile.resetStartPos.y + (tile.initialWorldPos.y - tile.resetStartPos.y) * t;
                const pz = tile.resetStartPos.z + (tile.initialWorldPos.z - tile.resetStartPos.z) * t;
                tile.rb.MovePosition(new BS.Vector3(px, py, pz));

                const rx = tile.resetStartRot.x + (tile.initialRotation.x - tile.resetStartRot.x) * t;
                const ry = tile.resetStartRot.y + (tile.initialRotation.y - tile.resetStartRot.y) * t;
                const rz = tile.resetStartRot.z + (tile.initialRotation.z - tile.resetStartRot.z) * t;
                const rw = tile.resetStartRot.w + (tile.initialRotation.w - tile.resetStartRot.w) * t;
                const mag = Math.sqrt(rx * rx + ry * ry + rz * rz + rw * rw);
                tile.rb.MoveRotation(new BS.Quaternion(rx / mag, ry / mag, rz / mag, rw / mag));
            });

            if (t < 1 && (gameState.status === "RESETTING" || gameState.status === "LOBBY")) {
                requestAnimationFrame(animate);
            } else {
                isResettingSmoothly = false;
                
                // Snap the resetting tiles perfectly into position at the end
                tiles.forEach(tile => {
                    if (tile.needsReset && tile.initialWorldPos) {
                         tile.rb.MovePosition(new BS.Vector3(tile.initialWorldPos.x, tile.initialWorldPos.y, tile.initialWorldPos.z));
                         tile.rb.MoveRotation(new BS.Quaternion(tile.initialRotation.x, tile.initialRotation.y, tile.initialRotation.z, tile.initialRotation.w));
                    }
                });
            }
        };
        requestAnimationFrame(animate);
    }

    function updateVisuals() {
        const isDropped = gameState.status === "DROPPED";
        const isResetting = gameState.status === "RESETTING" || gameState.status === "LOBBY";

        tiles.forEach((tile, index) => {
            const colorIdx = Math.floor(seededRandom(gameState.seed + index) * COLORS.length);
            tile.mat.color = COLORS[colorIdx].vec;

            if (isDropped) {
                if (colorIdx !== gameState.targetColorIndex) {
                    tile.rb.isKinematic = false;
                }
            }
        });

        if (isResetting) {
            startSmoothReset();
        }
    }

    function updateScoreboard() {
        if (!uiElements.leaderboardContent || !uiElements.leaderboardPageInfo) return;
        const state = scene.spaceState.public;
        const players = [];
        Object.keys(state).forEach(key => {
            if (key.startsWith(USER_DATA_KEY_PREFIX)) { try { players.push(JSON.parse(state[key])); } catch (e) {} }
        });

        let sorted = [];
        let formatter = null;
        let title = "";

        if (uiState.leaderboardTab === 'falls') {
            title = "MOST FALLS";
            sorted = [...players].sort((a, b) => b.falls - a.falls);
            formatter = p => p.falls;
        } else if (uiState.leaderboardTab === 'normal') {
            title = `NORMAL SURVIVAL (${uiState.leaderboardSizeFilter === 'small' ? '12x12' : '8x8'})`;
            if (uiState.leaderboardSizeFilter === 'small') {
                sorted = [...players].filter(p => p.bestNormalSmall > 0).sort((a, b) => b.bestNormalSmall - a.bestNormalSmall);
                formatter = p => (p.bestNormalSmall / 1000).toFixed(1) + "s";
            } else {
                sorted = [...players].filter(p => p.bestNormal > 0).sort((a, b) => b.bestNormal - a.bestNormal);
                formatter = p => (p.bestNormal / 1000).toFixed(1) + "s";
            }
        } else if (uiState.leaderboardTab === 'hard') {
            title = `HARD SURVIVAL (${uiState.leaderboardSizeFilter === 'small' ? '12x12' : '8x8'})`;
            if (uiState.leaderboardSizeFilter === 'small') {
                sorted = [...players].filter(p => p.bestHardSmall > 0).sort((a, b) => b.bestHardSmall - a.bestHardSmall);
                formatter = p => (p.bestHardSmall / 1000).toFixed(1) + "s";
            } else {
                sorted = [...players].filter(p => p.bestHard > 0).sort((a, b) => b.bestHard - a.bestHard);
                formatter = p => (p.bestHard / 1000).toFixed(1) + "s";
            }
        }

        const totalPages = Math.max(1, Math.ceil(sorted.length / uiState.playersPerPage));
        // Clamp page if it went out of bounds (e.g. from tab switch)
        if (uiState.leaderboardPage >= totalPages) {
            uiState.leaderboardPage = totalPages - 1;
        }

        const startIndex = uiState.leaderboardPage * uiState.playersPerPage;
        const pageData = sorted.slice(startIndex, startIndex + uiState.playersPerPage);

        let str = "";
        if (pageData.length === 0) {
            str = "No records yet!";
        } else {
            pageData.forEach((p, i) => {
                const rank = startIndex + i + 1;
                str += `${rank}. ${p.name}: ${formatter(p)}\n`;
            });
        }

        uiElements.leaderboardContent.text = str;
        uiElements.leaderboardPageInfo.text = `Page ${uiState.leaderboardPage + 1} of ${totalPages}`;
    }

    function updateUserStats(survivalTime, modeAtStart) {
        console.log(`DROP GAME: Updating stats. SurvivalTime: ${survivalTime}, ModeAtStart: ${modeAtStart}`);
        const uid = scene.localUser.uid;
        const key = USER_DATA_KEY_PREFIX + uid;
        let stats = { uid: uid, name: scene.localUser.name.replace(/<[^>]*>/g, ''), falls: 0, bestNormal: 0, bestHard: 0, bestNormalSmall: 0, bestHardSmall: 0 };
        const raw = scene.spaceState.public[key];
        if (raw) { 
            try { 
                const parsed = JSON.parse(raw);
                stats = { ...stats, ...parsed };
            } catch (e) {} 
        }
        stats.falls++;
        stats.name = scene.localUser.name.replace(/<[^>]*>/g, '');
        if (survivalTime > 0) {
            const isSmall = gameGridModeAtStart === 'small';
            if (modeAtStart) { 
                if (isSmall) { if (survivalTime > stats.bestHardSmall) stats.bestHardSmall = survivalTime; }
                else { if (survivalTime > stats.bestHard) stats.bestHard = survivalTime; }
            } else { 
                if (isSmall) { if (survivalTime > stats.bestNormalSmall) stats.bestNormalSmall = survivalTime; }
                else { if (survivalTime > stats.bestNormal) stats.bestNormal = survivalTime; }
            }
        }
        console.log(`DROP GAME: Saving stats for ${stats.name}:`, stats);
        scene.SetPublicSpaceProps({ [key]: JSON.stringify(stats) });
    }

    let lastTick = 0;
    function update() {
        const now = Date.now();

        if (gameState.hostStealStartTime > 0 && gameState.hostStealRequesterUid === scene.localUser?.uid) {
            if (now - gameState.hostStealStartTime >= TIMINGS.HOST_STEAL_DURATION) {
                updateState({ currentHostUid: scene.localUser.uid, hostStealStartTime: 0, hostStealRequesterUid: null });
            }
        }

        // Survival timer logic
        const isGameFlowing = gameState.status === "SHOWING" || gameState.status === "DROPPED" || (gameState.status === "RESETTING" && gameState.round > 0);

        if (isLocalInArena && isGameFlowing) {
            if (gameStartTime === 0) {
                console.log("DROP GAME: Starting survival timer");
                gameStartTime = now;
                gameModeAtStart = gameState.hardMode;
                gameGridModeAtStart = gameState.gridMode;
            }
            const hostPresent = gameState.currentHostUid && scene.users[gameState.currentHostUid];
            if (!hostPresent) {
                // If no host, assign temporary host by lowest UID.
                const allUsers = Object.keys(scene.users || {}).sort();
                if (allUsers.length === 0) return;
                const lowestUid = allUsers[0];
                if (!scene.users[lowestUid]) { return; } // Cannot assign host
                console.log(`DROP GAME: No host found in LOBBY. Enforcing temporary host by lowest UID: ${lowestUid}`);
                updateState({ currentHostUid: lowestUid, hostStealStartTime: 0, hostStealRequesterUid: null });
            }
        } else if (!isGameFlowing || (gameState.status === "LOBBY" && gameStartTime !== 0)) {
            // Only reset the timer if the game explicitly stops or enters initial pre-game reset
            if (gameStartTime !== 0) {
                console.log(`DROP GAME: Resetting survival timer (Game Stopped)`);
                gameStartTime = 0;
            }
        }

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
        } else if (gameState.status === "LOBBY") displayStr = "DROP GAME";
        else if (gameState.status === "DROPPED") displayStr = "!!!";
        else if (gameState.status === "WINNER") {
            const winnerUser = scene.users[gameState.winnerUid];
            const name = winnerUser ? winnerUser.name.replace(/<[^>]*>/g, '') : "SOMEONE";
            displayStr = `WINNER\n${name}`;
        }
        else displayStr = "WAIT";

        ui.displays.forEach(d => {
            d.text.text = displayStr;
            d.mat.color = colorVec;
            d.cube.SetActive(colorVisible);
        });

        if (uiElements.hostDisplay) {
            const hostUser = scene.users[gameState.currentHostUid];
            const requester = scene.users[gameState.hostStealRequesterUid];
            if (gameState.hostStealStartTime > 0 && requester) {
                const remainingHost = Math.max(0, Math.ceil((TIMINGS.HOST_STEAL_DURATION - (now - gameState.hostStealStartTime)) / 1000));
                uiElements.hostDisplay.text = `<color=#ff0000>STEALING HOST: ${remainingHost}s</color>\n(Requested by: ${requester.name})`;
            } else {
                uiElements.hostDisplay.text = hostUser ? `CURRENT HOST: ${hostUser.name}` : "NO HOST ASSIGNED";
            }
        }

        // Periodically update button visibility to ensure consistency
        updateButtonVisibility();

        if (isHost()) driveHostLogic(now);
    }

    function driveHostLogic(now) {
        if (now < gameState.endTime) return;

        // Prevent update spam by acting as a transaction lock if the host has poor internet
        if (now - lastHostActionTime < 1000) return;
        lastHostActionTime = now;

        if (gameState.status === "SHOWING") updateState({ status: "DROPPED", endTime: now + (TIMINGS.DROPPED * 1000) });
        else if (gameState.status === "DROPPED") {
            const nextSeed = gameState.hardMode ? Math.floor(Math.random() * 999999) : gameState.seed;
            updateState({ status: "RESETTING", seed: nextSeed, endTime: now + (TIMINGS.RESETTING * 1000) });
        } else if (gameState.status === "RESETTING") startNextRound(gameState.round + 1, gameState.seed);
        else if (gameState.status === "WINNER") updateState({ status: "LOBBY", winnerUid: null });
    }

    function startNextRound(roundNum, seed) {
        const speedScale = gameState.hardMode ? 0.6 : 0.35;
        const duration = Math.max(1.8, gameState.initialCountdown - (roundNum * speedScale));

        // Calculate available colors on the board for this seed
        const availableColors = new Set();
        for (let i = 0; i < GRID_SIZE * GRID_SIZE; i++) {
            availableColors.add(Math.floor(seededRandom(seed + i) * COLORS.length));
        }
        const colorsList = Array.from(availableColors);

        // Pick one of the available colors
        const targetColorIndex = colorsList.length > 0
            ? colorsList[Math.floor(Math.random() * colorsList.length)]
            : Math.floor(Math.random() * COLORS.length);

        updateState({ status: "SHOWING", round: roundNum, seed: seed, targetColorIndex: targetColorIndex, endTime: Date.now() + (duration * 1000) });
    }

    function updateState(patch) {
        Object.assign(gameState, patch);
        scene.SetPublicSpaceProps({ [STATE_KEY]: JSON.stringify(gameState) });
        updateButtonVisibility();
    }

    function removePlayerFromActive(uid) {
        if (!gameState.activePlayersList || !gameState.activePlayersList.includes(uid)) return;
        const newList = gameState.activePlayersList.filter(id => id !== uid);
        
        let patch = { activePlayersList: newList };

        if (gameState.status !== "LOBBY" && gameState.status !== "WINNER") {
            if (newList.length === 1 && gameState.initialPlayersCount > 1) {
                patch.status = "WINNER";
                patch.winnerUid = newList[0];
                patch.endTime = Date.now() + 5000;
            } else if (newList.length === 0) {
                patch.status = "LOBBY";
            }
        }
        updateState(patch);
    }

    async function createPerformantAnimatedSkybox() {
        const scene = BS.BanterScene.GetInstance();
        
        const skyboxRoot = await new BS.GameObject({ name: "AnimatedSkybox" }).Async();
        const rootTransform = await skyboxRoot.AddComponent(new BS.Transform());
        // --- Outer Sphere (Solid Background) ---
        const outerSphere = await new BS.GameObject({ name: "OuterSky", parent: skyboxRoot}).Async();
        await outerSphere.AddComponent(new BS.BanterSphere({ radius: 300}));
        await outerSphere.AddComponent(new BS.BanterInvertedMesh());
        await outerSphere.AddComponent(new BS.BanterMaterial({
            shaderName: "Unlit/Diffuse", 
            texture: "https://drop.firer.at/Assets/skybox-4k-zc.jpg", 
            color: new BS.Vector4(1, 1, 1, 1),
            side: BS.MaterialSide.Front
        }));
        const outerTransform = await outerSphere.AddComponent(new BS.Transform());
        // --- Inner Sphere (Transparent Overlay) ---
        const innerSphere = await new BS.GameObject({ name: "InnerSky", parent: skyboxRoot}).Async();
        // Slightly smaller radius to avoid Z-fighting
        await innerSphere.AddComponent(new BS.BanterSphere({ radius: 290}));
        await innerSphere.AddComponent(new BS.BanterInvertedMesh());
        await innerSphere.AddComponent(new BS.BanterMaterial({
            // Use a transparent unlit shader. "Sprites/Default" or "Unlit/Transparent" usually work well in Unity/Banter.
            shaderName: "Unlit/Transparent", 
            texture: "https://drop.firer.at/Assets/StarField_4K.png",
            color: new BS.Vector4(1, 1, 1, 0.8), // Slight tint/transparency
            side: BS.MaterialSide.Front
        }));
        const innerTransform = await innerSphere.AddComponent(new BS.Transform());
        // --- The Animation Loop ---
        let outerRotY = 0;
        let innerRotX = 0;
        let innerRotY = 0;
        
        function animate() {
            // Different rotation speeds and axes create the shifting effect
            outerRotY += 0.001;
            innerRotX += 0.0005;
            innerRotY -= 0.0015;
            
            // Wrap angles to prevent floating point imprecision over hours
            if (outerRotY >= 360) outerRotY -= 360;
            if (innerRotX >= 360) innerRotX -= 360;
            if (innerRotY <= -360) innerRotY += 360;
            // Apply rotations
            outerTransform.localEulerAngles = new BS.Vector3(0, outerRotY, 0);
            innerTransform.localEulerAngles = new BS.Vector3(innerRotX, innerRotY, 0);
            requestAnimationFrame(animate);
        }
        // Start the loop
        animate();
    }

    if (window.BS) init();
    else window.addEventListener("bs-loaded", init);
})();
