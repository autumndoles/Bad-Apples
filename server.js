const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

const games = new Map();

/* =========================================================
GAME SETTINGS
========================================================= */

const DISCUSSION_DURATION = 90000; // 90 seconds
const ABILITIES_DURATION = 10000;  // 10 seconds
const EVIDENCE_DURATION = 5000;    // 5 seconds
const ANSWER_DURATION = 30000;     // 30 seconds

/* =========================================================
QUESTIONS
========================================================= */

const QUESTIONS = [
    {
        question: "What planet is known as the Red Planet?",
        answers: ["mars"]
    },
    {
        question: "How many sides does a hexagon have?",
        answers: ["6", "six"]
    },
    {
        question: "What is the capital of France?",
        answers: ["paris"]
    },
    {
        question: "What animal is known as man's best friend?",
        answers: ["dog"]
    },
    {
        question: "What is 5 + 7?",
        answers: ["12", "twelve"]
    },
    {
        question: "What gas do plants absorb from the atmosphere?",
        answers: ["carbon dioxide", "co2"]
    },
    {
        question: "How many continents are there?",
        answers: ["7", "seven"]
    },
    {
        question: "What is the largest ocean on Earth?",
        answers: ["pacific", "pacific ocean"]
    }
];

/* =========================================================
UTILITY
========================================================= */

function generateGameCode() {
    let code;

    do {
        code = Math.random()
            .toString(36)
            .substring(2, 8)
            .toUpperCase();
    } while (games.has(code));

    return code;
}

function generateBotName(players) {
    const usedNames = new Set(
        players.map(player => player.name)
    );

    let number = 1;

    while (usedNames.has(`Bot ${number}`)) {
        number++;
    }

    return `Bot ${number}`;
}

function normalizeAnswer(answer) {
    return String(answer || "")
        .trim()
        .toLowerCase();
}

function isAnswerCorrect(question, answer) {
    if (!question) {
        return false;
    }

    const normalized = normalizeAnswer(answer);

    return question.answers.some(
        correct =>
            normalizeAnswer(correct) === normalized
    );
}

function getGame(code) {
    return games.get(
        String(code || "")
            .trim()
            .toUpperCase()
    );
}

function getPlayingPlayers(game) {
    return game.players.filter(
        player => player.isPlaying !== false
    );
}

function getPlayerBySocket(game, socketId) {
    return game.players.find(
        player => player.id === socketId
    );
}

function broadcastLobby(game) {
    io.to(game.code).emit(
        "lobbyUpdate",
        {
            players: game.players.map(player => ({
                id: player.id,
                name: player.name,
                isHost: player.isHost,
                isBot: player.isBot,
                isPlaying: player.isPlaying
            }))
        }
    );
}

function sendError(socket, message) {
    socket.emit(
        "errorMessage",
        message
    );
}

function getRandomQuestion() {
    return QUESTIONS[
        Math.floor(
            Math.random() * QUESTIONS.length
        )
    ];
}

/* =========================================================
TIMER MANAGEMENT
========================================================= */

function clearGameTimers(game) {
    if (!game) {
        return;
    }

    if (game.answerTimer) {
        clearTimeout(game.answerTimer);
        game.answerTimer = null;
    }

    if (game.discussionTimer) {
        clearTimeout(game.discussionTimer);
        game.discussionTimer = null;
    }

    if (game.abilitiesTimer) {
        clearTimeout(game.abilitiesTimer);
        game.abilitiesTimer = null;
    }

    if (game.evidenceTimer) {
        clearTimeout(game.evidenceTimer);
        game.evidenceTimer = null;
    }

    if (game.nextRoundTimer) {
        clearTimeout(game.nextRoundTimer);
        game.nextRoundTimer = null;
    }

    if (game.botTimer) {
        clearTimeout(game.botTimer);
        game.botTimer = null;
    }
}

function endGame(game, message) {
    if (!game) {
        return;
    }

    clearGameTimers(game);

    game.started = false;
    game.phase = "gameOver";

    io.to(game.code).emit(
        "gameOver",
        {
            message,
            roles: game.players.map(player => ({
                name: player.name,
                role: player.role,
                isPlaying: player.isPlaying
            }))
        }
    );
}

/* =========================================================
ROLE ASSIGNMENT
========================================================= */

function assignRoles(game) {
    const players = getPlayingPlayers(game);

    if (players.length < 4) {
        return false;
    }

    const badAppleCount = Math.max(
        1,
        Math.floor(players.length / 3)
    );

    const shuffled = [...players].sort(
        () => Math.random() - 0.5
    );

    shuffled.forEach(player => {
        player.role = "Red Apple";
        player.shieldUsed = false;
        player.hint = null;
    });

    for (let i = 0; i < badAppleCount; i++) {
        shuffled[i].role = "Bad Apple";
    }

    /*
    BANANA

    Appears with 6+ players.
    The Banana is never a Bad Apple.
    */

    if (players.length >= 6) {
        const available = shuffled.filter(
            player =>
                player.role === "Red Apple"
        );

        if (available.length > 0) {
            const banana =
                available[
                    Math.floor(
                        Math.random() *
                        available.length
                    )
                ];

            banana.role = "Banana";
        }
    }

    return true;
}

/* =========================================================
SEND ROLES
========================================================= */

function sendRoles(game) {
    game.players
        .filter(
            player =>
                player.isPlaying &&
                !player.isBot
        )
        .forEach(player => {
            const playerSocket =
                io.sockets.sockets.get(
                    player.id
                );

            if (!playerSocket) {
                return;
            }

            playerSocket.emit(
                "roleAssigned",
                {
                    role: player.role
                }
            );
        });

    /*
    HOST SPECTATOR ROLE OVERVIEW
    */

    const host =
        game.players.find(
            player => player.isHost
        );

    if (host && !host.isPlaying) {
        const hostSocket =
            io.sockets.sockets.get(
                host.id
            );

        if (hostSocket) {
            hostSocket.emit(
                "hostRoleOverview",
                {
                    players:
                        game.players
                            .filter(
                                player =>
                                    player.isPlaying
                            )
                            .map(
                                player => ({
                                    name:
                                        player.name,
                                    role:
                                        player.role
                                })
                            )
                }
            );
        }
    }
}

/* =========================================================
BAD APPLE HINTS
========================================================= */

function giveBadAppleHints(game) {
    game.players
        .filter(
            player =>
                player.isPlaying &&
                player.role === "Bad Apple"
        )
        .forEach(badApple => {
            const nextQuestion =
                getRandomQuestion();

            badApple.hint =
                nextQuestion.question;

            if (badApple.isBot) {
                return;
            }

            const playerSocket =
                io.sockets.sockets.get(
                    badApple.id
                );

            if (playerSocket) {
                playerSocket.emit(
                    "badAppleHint",
                    {
                        hint:
                            badApple.hint
                    }
                );
            }
        });
}

/* =========================================================
BOT ANSWERS
========================================================= */

function botAnswer(game, bot) {
    if (!game.currentQuestion) {
        return;
    }

    const question =
        game.currentQuestion;

    const correct =
        question.answers[
            Math.floor(
                Math.random() *
                question.answers.length
            )
        ];

    const answerCorrect =
        Math.random() < 0.7;

    bot.answer =
        answerCorrect
            ? correct
            : "incorrect answer";

    game.answers[bot.id] =
        bot.answer;
}

/* =========================================================
BOT ABILITIES
========================================================= */

function botUseAbility(game, bot) {
    if (
        !bot ||
        !bot.isPlaying
    ) {
        return;
    }

    /*
    RED APPLE SHIELD
    */

    if (
        bot.role === "Red Apple" &&
        !bot.shieldUsed
    ) {
        const targets =
            getPlayingPlayers(game)
                .filter(
                    player =>
                        player.id !== bot.id
                );

        if (targets.length > 0) {
            const target =
                targets[
                    Math.floor(
                        Math.random() *
                        targets.length
                    )
                ];

            game.shields[target.id] =
                bot.id;

            bot.shieldUsed = true;
        }
    }
}

/* =========================================================
BOT VOTING
========================================================= */

function botVote(game, bot) {
    const targets =
        getPlayingPlayers(game).filter(
            player =>
                player.id !== bot.id
        );

    if (targets.length === 0) {
        return;
    }

    const botCorrect =
        isAnswerCorrect(
            game.currentQuestion,
            game.answers[bot.id]
        );

    if (!botCorrect) {
        return;
    }

    let target;

    if (bot.role === "Bad Apple") {
        const redPlayers =
            targets.filter(
                player =>
                    player.role !== "Bad Apple"
            );

        target =
            redPlayers.length > 0
                ? redPlayers[
                    Math.floor(
                        Math.random() *
                        redPlayers.length
                    )
                ]
                : targets[
                    Math.floor(
                        Math.random() *
                        targets.length
                    )
                ];
    } else {
        const badApples =
            targets.filter(
                player =>
                    player.role === "Bad Apple"
            );

        target =
            badApples.length > 0
                ? badApples[
                    Math.floor(
                        Math.random() *
                        badApples.length
                    )
                ]
                : targets[
                    Math.floor(
                        Math.random() *
                        targets.length
                    )
                ];
    }

    game.votes[bot.id] =
        target.name;
}

/* =========================================================
CHECK ALL ANSWERS
========================================================= */

function checkAllAnswers(game) {
    if (
        !game ||
        !game.started ||
        game.phase !== "answer"
    ) {
        return;
    }

    const players =
        getPlayingPlayers(game);

    const allAnswered =
        players.every(
            player =>
                game.answers[player.id] !==
                undefined
        );

    if (!allAnswered) {
        return;
    }

    if (game.answerTimer) {
        clearTimeout(
            game.answerTimer
        );

        game.answerTimer =
            null;
    }

    setTimeout(
        () => {
            if (
                game.started &&
                game.phase === "answer"
            ) {
                finishAnswerPhase(game);
            }
        },
        500
    );
}

/* =========================================================
FINISH ANSWER PHASE
========================================================= */

function finishAnswerPhase(game) {
    if (!games.has(game.code)) {
        return;
    }

    if (!game.started) {
        return;
    }

    if (game.phase !== "answer") {
        return;
    }

    const players =
        getPlayingPlayers(game);

    game.correctAnswers = 0;
    game.answerResults = {};

    players.forEach(player => {
        const correct =
            isAnswerCorrect(
                game.currentQuestion,
                game.answers[player.id]
            );

        game.answerResults[player.id] =
            correct;

        if (correct) {
            game.correctAnswers++;
        }
    });

    game.votes = {};
    game.shields = {};

    players.forEach(player => {
        if (
            player.role === "Red Apple"
        ) {
            player.shieldUsed = false;
        }
    });

    startDiscussionPhase(game);
}

/* =========================================================
DISCUSSION PHASE
========================================================= */

function startDiscussionPhase(game) {
    if (
        !game ||
        !game.started
    ) {
        return;
    }

    clearPhaseTimers(game);

    game.phase =
        "discussion";

    io.to(game.code).emit(
        "discussionStarted",
        {
            duration:
                DISCUSSION_DURATION
        }
    );

    game.discussionTimer =
        setTimeout(
            () => {
                game.discussionTimer =
                    null;

                if (
                    !game.started ||
                    game.phase !==
                    "discussion"
                ) {
                    return;
                }

                startAbilitiesPhase(game);
            },
            DISCUSSION_DURATION
        );
}

/* =========================================================
CLEAR PHASE TIMERS
========================================================= */

function clearPhaseTimers(game) {
    if (game.discussionTimer) {
        clearTimeout(
            game.discussionTimer
        );

        game.discussionTimer =
            null;
    }

    if (game.abilitiesTimer) {
        clearTimeout(
            game.abilitiesTimer
        );

        game.abilitiesTimer =
            null;
    }

    if (game.evidenceTimer) {
        clearTimeout(
            game.evidenceTimer
        );

        game.evidenceTimer =
            null;
    }
}

/* =========================================================
ABILITIES PHASE
========================================================= */

function startAbilitiesPhase(game) {
    if (
        !game ||
        !game.started
    ) {
        return;
    }

    clearPhaseTimers(game);

    game.phase =
        "abilities";

    /*
    BOTS USE ABILITIES
    */

    getPlayingPlayers(game)
        .filter(
            player =>
                player.isBot
        )
        .forEach(
            bot =>
                botUseAbility(
                    game,
                    bot
                )
        );

    io.to(game.code).emit(
        "abilitiesStarted",
        {
            duration:
                ABILITIES_DURATION,

            shields:
                Object.keys(
                    game.shields
                )
        }
    );

    io.to(game.code).emit(
        "abilitiesUpdated",
        {
            shields:
                Object.keys(
                    game.shields
                )
        }
    );

    game.abilitiesTimer =
        setTimeout(
            () => {
                game.abilitiesTimer =
                    null;

                if (
                    !game.started ||
                    game.phase !==
                    "abilities"
                ) {
                    return;
                }

                startVotingPhase(game);
            },
            ABILITIES_DURATION
        );
}

/* =========================================================
START VOTING
========================================================= */

function startVotingPhase(game) {
    if (
        !game ||
        !game.started
    ) {
        return;
    }

    clearPhaseTimers(game);

    const players =
        getPlayingPlayers(game);

    game.phase =
        "voting";

    game.votes = {};

    io.to(game.code).emit(
        "votingStarted",
        {
            players:
                players.map(
                    player =>
                        player.name
                )
        }
    );

    game.botTimer =
        setTimeout(
            () => {
                game.botTimer =
                    null;

                if (
                    !game.started ||
                    game.phase !==
                    "voting"
                ) {
                    return;
                }

                getPlayingPlayers(game)
                    .filter(
                        player =>
                            player.isBot
                    )
                    .forEach(
                        bot =>
                            botVote(
                                game,
                                bot
                            )
                    );

                checkAllVotes(game);
            },
            800
        );
}

/* =========================================================
CHECK ALL VOTES
========================================================= */

function checkAllVotes(game) {
    if (
        !game ||
        !game.started ||
        game.phase !== "voting"
    ) {
        return;
    }

    const players =
        getPlayingPlayers(game);

    const allVoted =
        players.every(
            player => {
                const correct =
                    game.answerResults[
                        player.id
                    ];

                if (!correct) {
                    return true;
                }

                return (
                    game.votes[
                        player.id
                    ] !== undefined
                );
            }
        );

    if (!allVoted) {
        return;
    }

    finishVoting(game);
}

/* =========================================================
FINISH VOTING / EVIDENCE
========================================================= */

function finishVoting(game) {
    if (
        !game ||
        !game.started ||
        game.phase !== "voting"
    ) {
        return;
    }

    clearPhaseTimers(game);

    game.phase =
        "evidence";

    const voteCounts = {};

    Object.entries(
        game.votes
    ).forEach(
        ([voterId, targetName]) => {
            const voter =
                game.players.find(
                    player =>
                        player.id ===
                        voterId
                );

            if (!voter) {
                return;
            }

            if (
                !game.answerResults[
                    voter.id
                ]
            ) {
                return;
            }

            voteCounts[targetName] =
                (
                    voteCounts[targetName] ||
                    0
                ) + 1;
        }
    );

    let eliminatedName =
        null;

    let highestVotes =
        0;

    Object.entries(
        voteCounts
    ).forEach(
        ([name, count]) => {
            if (
                count >
                highestVotes
            ) {
                highestVotes =
                    count;

                eliminatedName =
                    name;
            }
        }
    );

    if (
        highestVotes === 0
    ) {
        eliminatedName =
            null;
    }

    /*
    IMPORTANT:
    The elimination is NOT applied yet.

    The evidence screen is shown first.
    */

    const evidence =
        game.players
            .filter(
                player =>
                    player.isPlaying
            )
            .map(
                player => ({
                    name:
                        player.name,

                    correct:
                        game.answerResults[
                            player.id
                        ] === true,

                    hadVote:
                        game.votes[
                            player.id
                        ] !== undefined,

                    vote:
                        game.votes[
                            player.id
                        ] || null
                })
            );

    game.pendingElimination =
        eliminatedName;

    io.to(game.code).emit(
        "evidencePhase",
        {
            evidence,
            eliminatedName,
            voteCounts
        }
    );

    game.evidenceTimer =
        setTimeout(
            () => {
                game.evidenceTimer =
                    null;

                if (
                    !game.started ||
                    game.phase !==
                    "evidence"
                ) {
                    return;
                }

                applyElimination(
                    game,
                    game.pendingElimination
                );
            },
            EVIDENCE_DURATION
        );
}

/* =========================================================
APPLY ELIMINATION
========================================================= */

function applyElimination(
    game,
    eliminatedName
) {
    if (
        !game ||
        !game.started ||
        game.phase !== "evidence"
    ) {
        return;
    }

    const eliminatedPlayer =
        game.players.find(
            player =>
                player.name ===
                eliminatedName &&
                player.isPlaying
        );

    /*
    NO ELIMINATION
    */

    if (!eliminatedPlayer) {
        game.phase =
            "result";

        io.to(game.code).emit(
            "roundResult",
            {
                message:
                    "Nobody was eliminated this round.",

                eliminated: false,

                shielded: null
            }
        );

        checkWinCondition(
            game
        );

        return;
    }

    /*
    SHIELD CHECK

    Shields are stored by target ID.
    */

    if (
        game.shields[
            eliminatedPlayer.id
        ]
    ) {
        game.phase =
            "result";

        io.to(game.code).emit(
            "roundResult",
            {
                message:
                    `${eliminatedPlayer.name} was protected by a shield and survived the vote.`,

                eliminated: false,

                shielded:
                    eliminatedPlayer.name
            }
        );

        checkWinCondition(
            game
        );

        return;
    }

    /*
    ELIMINATE PLAYER
    */

    eliminatedPlayer.isPlaying =
        false;

    game.phase =
        "result";

    io.to(game.code).emit(
        "roundResult",
        {
            message:
                `${eliminatedPlayer.name} was eliminated. They were a ${eliminatedPlayer.role}.`,

            eliminated: true,

            eliminatedPlayer:
                eliminatedPlayer.name,

            role:
                eliminatedPlayer.role
        }
    );

    checkWinCondition(
        game
    );
}

/* =========================================================
WIN CONDITION
========================================================= */

function checkWinCondition(game) {
    if (
        !game ||
        !game.started
    ) {
        return true;
    }

    const playing =
        getPlayingPlayers(game);

    const badApples =
        playing.filter(
            player =>
                player.role ===
                "Bad Apple"
        );

    const goodPlayers =
        playing.filter(
            player =>
                player.role !==
                "Bad Apple"
        );

    let winner =
        null;

    /*
    ALL BAD APPLES ARE GONE
    */

    if (
        badApples.length === 0
    ) {
        winner =
            "The Red Apples win!";
    }

    /*
    BAD APPLES EQUAL OR OUTNUMBER
    THE OTHER PLAYERS
    */

    else if (
        badApples.length >=
        goodPlayers.length
    ) {
        winner =
            "The Bad Apples win!";
    }

    if (winner) {
        endGame(
            game,
            winner
        );

        return true;
    }

    /*
    START NEXT ROUND
    */

    game.nextRoundTimer =
        setTimeout(
            () => {
                game.nextRoundTimer =
                    null;

                if (
                    game.started &&
                    game.phase ===
                    "result"
                ) {
                    startNextRound(
                        game
                    );
                }
            },
            2500
        );

    return false;
}

/* =========================================================
START NEXT ROUND
========================================================= */

function startNextRound(game) {
    if (
        !game ||
        !game.started
    ) {
        return;
    }

    game.phase =
        "answer";

    game.answers = {};
    game.votes = {};
    game.answerResults = {};
    game.shields = {};
    game.pendingElimination =
        null;

    game.currentQuestion =
        getRandomQuestion();

    io.to(game.code).emit(
        "newQuestion",
        {
            question:
                game.currentQuestion.question,

            options: []
        }
    );

    /*
    GIVE BAD APPLES THEIR HINTS
    */

    giveBadAppleHints(game);

    /*
    BOTS ANSWER
    */

    game.botTimer =
        setTimeout(
            () => {
                game.botTimer =
                    null;

                if (
                    !game.started ||
                    game.phase !==
                    "answer"
                ) {
                    return;
                }

                getPlayingPlayers(game)
                    .filter(
                        player =>
                            player.isBot
                    )
                    .forEach(
                        bot =>
                            botAnswer(
                                game,
                                bot
                            )
                    );

                checkAllAnswers(
                    game
                );
            },
            1000
        );

    /*
    ANSWER TIMEOUT
    */

    game.answerTimer =
        setTimeout(
            () => {
                game.answerTimer =
                    null;

                if (
                    !game.started ||
                    game.phase !==
                    "answer"
                ) {
                    return;
                }

                getPlayingPlayers(game)
                    .forEach(
                        player => {
                            if (
                                game.answers[
                                    player.id
                                ] === undefined
                            ) {
                                game.answers[
                                    player.id
                                ] = "";
                            }
                        }
                    );

                finishAnswerPhase(
                    game
                );
            },
            ANSWER_DURATION
        );
}

/* =========================================================
SOCKET.IO
========================================================= */

io.on(
    "connection",
    socket => {
        console.log(
            "Player connected:",
            socket.id
        );

        /* =================================================
        CREATE GAME
        ================================================= */

        socket.on(
            "createGame",
            data => {
                const code =
                    generateGameCode();

                const game = {
                    code,

                    mode:
                        data.mode ||
                        "classic",

                    maxPlayers:
                        Number(
                            data.maxPlayers
                        ) || 10,

                    hostId:
                        socket.id,

                    players: [],

                    started:
                        false,

                    phase:
                        "lobby",

                    currentQuestion:
                        null,

                    answers: {},

                    answerResults: {},

                    votes: {},

                    shields: {},

                    pendingElimination:
                        null,

                    answerTimer:
                        null,

                    discussionTimer:
                        null,

                    abilitiesTimer:
                        null,

                    evidenceTimer:
                        null,

                    nextRoundTimer:
                        null,

                    botTimer:
                        null
                };

                const host = {
                    id:
                        socket.id,

                    name:
                        String(
                            data.name ||
                            "Host"
                        )
                        .trim(),

                    isHost:
                        true,

                    isBot:
                        false,

                    isPlaying:
                        data.hostPlaying !== false,

                    role:
                        null,

                    shieldUsed:
                        false,

                    hint:
                        null
                };

                game.players.push(
                    host
                );

                games.set(
                    code,
                    game
                );

                socket.join(
                    code
                );

                socket.emit(
                    "gameCreated",
                    {
                        gameCode:
                            code
                    }
                );

                broadcastLobby(
                    game
                );

                console.log(
                    `Game ${code} created by ${host.name}`
                );
            }
        );

        /* =================================================
        JOIN GAME
        ================================================= */

        socket.on(
            "joinGame",
            data => {
                const code =
                    String(
                        data.gameCode ||
                        ""
                    )
                    .trim()
                    .toUpperCase();

                const game =
                    getGame(code);

                if (!game) {
                    sendError(
                        socket,
                        "Game not found."
                    );

                    return;
                }

                if (game.started) {
                    sendError(
                        socket,
                        "That game has already started."
                    );

                    return;
                }

                if (
                    game.players.length >=
                    game.maxPlayers
                ) {
                    sendError(
                        socket,
                        "That game is full."
                    );

                    return;
                }

                const name =
                    String(
                        data.name ||
                        ""
                    )
                    .trim();

                if (!name) {
                    sendError(
                        socket,
                        "Please enter a name."
                    );

                    return;
                }

                const duplicate =
                    game.players.some(
                        player =>
                            player.name
                                .toLowerCase() ===
                            name.toLowerCase()
                    );

                if (duplicate) {
                    sendError(
                        socket,
                        "That name is already being used."
                    );

                    return;
                }

                const player = {
                    id:
                        socket.id,

                    name,

                    isHost:
                        false,

                    isBot:
                        false,

                    isPlaying:
                        true,

                    role:
                        null,

                    shieldUsed:
                        false,

                    hint:
                        null
                };

                game.players.push(
                    player
                );

                socket.join(
                    code
                );

                socket.emit(
                    "gameJoined",
                    {
                        gameCode:
                            code
                    }
                );

                broadcastLobby(
                    game
                );
            }
        );

        /* =================================================
        ADD BOTS
        ================================================= */

        socket.on(
            "addBots",
            data => {
                const game =
                    getGame(
                        data.gameCode
                    );

                if (!game) {
                    return;
                }

                if (
                    game.hostId !==
                    socket.id
                ) {
                    return;
                }

                if (game.started) {
                    return;
                }

                const count =
                    Math.max(
                        1,
                        Number(
                            data.count
                        ) || 1
                    );

                let added =
                    0;

                while (
                    added < count &&
                    game.players.length <
                    game.maxPlayers
                ) {
                    const bot = {
                        id:
                            `bot-${Date.now()}-${Math.random()
                                .toString(36)
                                .substring(2)}`,

                        name:
                            generateBotName(
                                game.players
                            ),

                        isHost:
                            false,

                        isBot:
                            true,

                        isPlaying:
                            true,

                        role:
                            null,

                        shieldUsed:
                            false,

                        hint:
                            null
                    };

                    game.players.push(
                        bot
                    );

                    added++;
                }

                broadcastLobby(
                    game
                );
            }
        );

        /* =================================================
        REMOVE BOTS
        ================================================= */

        socket.on(
            "removeBots",
            data => {
                const game =
                    getGame(
                        data.gameCode
                    );

                if (!game) {
                    return;
                }

                if (
                    game.hostId !==
                    socket.id
                ) {
                    return;
                }

                if (game.started) {
                    return;
                }

                let count =
                    Math.max(
                        1,
                        Number(
                            data.count
                        ) || 1
                    );

                for (
                    let i =
                        game.players.length - 1;

                    i >= 0 &&
                    count > 0;

                    i--
                ) {
                    if (
                        game.players[i]
                            .isBot
                    ) {
                        game.players.splice(
                            i,
                            1
                        );

                        count--;
                    }
                }

                broadcastLobby(
                    game
                );
            }
        );

        /* =================================================
        CHAT
        ================================================= */

        socket.on(
            "chatMessage",
            data => {
                const game =
                    getGame(
                        data.gameCode
                    );

                if (!game) {
                    return;
                }

                const player =
                    getPlayerBySocket(
                        game,
                        socket.id
                    );

                if (!player) {
                    return;
                }

                if (
                    player.isHost &&
                    !player.isPlaying
                ) {
                    return;
                }

                const message =
                    String(
                        data.message ||
                        ""
                    )
                    .substring(
                        0,
                        300
                    );

                if (
                    !message.trim()
                ) {
                    return;
                }

                io.to(game.code).emit(
                    "chatMessage",
                    {
                        name:
                            player.name,

                        message
                    }
                );
            }
        );

        /* =================================================
        CLEAR CHAT
        ================================================= */

        socket.on(
            "clearChat",
            data => {
                const game =
                    getGame(
                        data.gameCode
                    );

                if (!game) {
                    return;
                }

                if (
                    game.hostId !==
                    socket.id
                ) {
                    return;
                }

                io.to(game.code).emit(
                    "chatCleared"
                );
            }
        );

        /* =================================================
        KICK PLAYER
        ================================================= */

        socket.on(
            "kickPlayer",
            data => {
                const game =
                    getGame(
                        data.gameCode
                    );

                if (!game) {
                    return;
                }

                if (
                    game.hostId !==
                    socket.id
                ) {
                    return;
                }

                const player =
                    game.players.find(
                        p =>
                            p.id ===
                            data.playerId
                    );

                if (!player) {
                    return;
                }

                if (player.isBot) {
                    game.players =
                        game.players.filter(
                            p =>
                                p.id !==
                                player.id
                        );

                    broadcastLobby(
                        game
                    );

                    return;
                }

                const targetSocket =
                    io.sockets.sockets.get(
                        player.id
                    );

                if (targetSocket) {
                    targetSocket.emit(
                        "kicked"
                    );

                    targetSocket.leave(
                        game.code
                    );
                }

                game.players =
                    game.players.filter(
                        p =>
                            p.id !==
                            player.id
                    );

                broadcastLobby(
                    game
                );
            }
        );

        /* =================================================
        START GAME
        ================================================= */

        socket.on(
            "startGame",
            data => {
                const game =
                    getGame(
                        data.gameCode
                    );

                if (!game) {
                    return;
                }

                if (
                    game.hostId !==
                    socket.id
                ) {
                    return;
                }

                if (game.started) {
                    return;
                }

                const players =
                    getPlayingPlayers(
                        game
                    );

                if (
                    players.length <
                    4
                ) {
                    sendError(
                        socket,
                        "You need at least 4 playing players."
                    );

                    return;
                }

                game.started =
                    true;

                game.phase =
                    "role";

                assignRoles(
                    game
                );

                io.to(game.code).emit(
                    "gameStarted",
                    {
                        players:
                            game.players.map(
                                player => ({
                                    name:
                                        player.name,

                                    isBot:
                                        player.isBot
                                })
                            )
                    }
                );

                sendRoles(
                    game
                );

                setTimeout(
                    () =>
                        startNextRound(
                            game
                        ),
                    1500
                );
            }
        );

        /* =================================================
        ANSWERS
        ================================================= */

        socket.on(
            "submitAnswer",
            data => {
                const game =
                    getGame(
                        data.gameCode
                    );

                if (!game) {
                    return;
                }

                if (
                    game.phase !==
                    "answer"
                ) {
                    return;
                }

                const player =
                    getPlayerBySocket(
                        game,
                        socket.id
                    );

                if (
                    !player ||
                    !player.isPlaying
                ) {
                    return;
                }

                if (
                    game.answers[
                        player.id
                    ] !== undefined
                ) {
                    return;
                }

                game.answers[
                    player.id
                ] =
                    data.answer;

                checkAllAnswers(
                    game
                );
            }
        );

        /* =================================================
        SHIELD ABILITY
        ================================================= */

        socket.on(
            "useShield",
            data => {
                const game =
                    getGame(
                        data.gameCode
                    );

                if (!game) {
                    return;
                }

                if (
                    game.phase !==
                    "discussion" &&
                    game.phase !==
                    "abilities"
                ) {
                    return;
                }

                const player =
                    getPlayerBySocket(
                        game,
                        socket.id
                    );

                if (
                    !player ||
                    !player.isPlaying
                ) {
                    return;
                }

                if (
                    player.role !==
                    "Red Apple"
                ) {
                    return;
                }

                if (
                    player.shieldUsed
                ) {
                    return;
                }

                const target =
                    game.players.find(
                        p =>
                            p.name ===
                            data.target &&
                            p.isPlaying
                    );

                if (!target) {
                    return;
                }

                if (
                    target.id ===
                    player.id
                ) {
                    sendError(
                        socket,
                        "You cannot shield yourself."
                    );

                    return;
                }

                game.shields[
                    target.id
                ] =
                    player.id;

                player.shieldUsed =
                    true;

                io.to(game.code).emit(
                    "abilitiesUpdated",
                    {
                        shields:
                            Object.keys(
                                game.shields
                            )
                    }
                );
            }
        );

        /* =================================================
        VOTES
        ================================================= */

        socket.on(
            "submitVote",
            data => {
                const game =
                    getGame(
                        data.gameCode
                    );

                if (!game) {
                    return;
                }

                if (
                    game.phase !==
                    "voting"
                ) {
                    return;
                }

                const player =
                    getPlayerBySocket(
                        game,
                        socket.id
                    );

                if (
                    !player ||
                    !player.isPlaying
                ) {
                    return;
                }

                if (
                    !game.answerResults[
                        player.id
                    ]
                ) {
                    sendError(
                        socket,
                        "You answered incorrectly and cannot vote this round."
                    );

                    return;
                }

                if (
                    game.votes[
                        player.id
                    ] !== undefined
                ) {
                    return;
                }

                const target =
                    game.players.find(
                        p =>
                            p.name ===
                            data.vote &&
                            p.isPlaying
                    );

                if (!target) {
                    return;
                }

                if (
                    target.id ===
                    player.id
                ) {
                    return;
                }

                game.votes[
                    player.id
                ] =
                    target.name;

                checkAllVotes(
                    game
                );
            }
        );

        /* =================================================
        END GAME
        ================================================= */

        socket.on(
            "endGame",
            data => {
                const game =
                    getGame(
                        data.gameCode
                    );

                if (!game) {
                    return;
                }

                if (
                    game.hostId !==
                    socket.id
                ) {
                    return;
                }

                endGame(
                    game,
                    "The host ended the game."
                );

                games.delete(
                    game.code
                );
            }
        );

        /* =================================================
        DISCONNECT
        ================================================= */

        socket.on(
            "disconnect",
            () => {
                console.log(
                    "Player disconnected:",
                    socket.id
                );

                for (
                    const [
                        code,
                        game
                    ] of games
                ) {
                    const player =
                        game.players.find(
                            p =>
                                p.id ===
                                socket.id
                        );

                    if (!player) {
                        continue;
                    }

                    /*
                    HOST DISCONNECTS
                    */

                    if (
                        game.hostId ===
                        socket.id
                    ) {
                        endGame(
                            game,
                            "The host disconnected. The game has ended."
                        );

                        games.delete(
                            code
                        );

                    } else {

                        /*
                        REMOVE PLAYER
                        */

                        game.players =
                            game.players.filter(
                                p =>
                                    p.id !==
                                    socket.id
                            );

                        /*
                        RECHECK ACTIVE PHASES
                        */

                        if (
                            game.started
                        ) {
                            if (
                                game.phase ===
                                "answer"
                            ) {
                                checkAllAnswers(
                                    game
                                );
                            } else if (
                                game.phase ===
                                "voting"
                            ) {
                                checkAllVotes(
                                    game
                                );
                            }
                        }

                        broadcastLobby(
                            game
                        );
                    }

                    break;
                }
            }
        );
    }
);

/* =========================================================
SERVE BAD APPLES+
========================================================= */

app.get(
    "/",
    (req, res) => {
        res.sendFile(
            path.join(
                __dirname,
                "Bad Apples+.html"
            )
        );
    }
);

/* =========================================================
START SERVER
========================================================= */

server.listen(
    PORT,
    "0.0.0.0",
    () => {
        console.log(
            `Bad Apples+ server running on port ${PORT}`
        );
    }
);
