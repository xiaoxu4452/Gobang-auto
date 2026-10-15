/*
 * Meter Gomoku - RapFi static-link C API (function-direct engine calls).
 * Replaces the anonymous-pipe engine channel: the engine runs inside the host
 * process, so there is no pipe jitter, TT/memory are directly controlled, and
 * multi-threaded search cooperates on one shared transposition table.
 * 米特五子棋 — RapFi 静态链接 C API（函数直接调用引擎）。
 */
#pragma once
#ifdef __cplusplus
extern "C" {
#endif

typedef void (*MR_OutputFn)(const char* line, void* user);

/* Init engine once: parse args, load config + NNUE model from exeDir.
 * Returns 0 on success. Must be called before any other MR_* function. */
int  MR_Init(const wchar_t* exeDir);

/* Capture engine output lines (MESSAGE/ERROR/info/bestmove). */
void MR_SetOutput(MR_OutputFn fn, void* user);

/* Rule id: 0 freestyle, 1 standard, 2/4 renju, 5 swap1, 6 swap2. */
void MR_SetRule(int rule);
/* Number of cooperating search threads (1..cores). */
void MR_SetThreads(int n);
/* Hash table size in MB (0 = engine default). */
void MR_SetHashMB(int mb);
/* Candidate range 0..5 (default 3). Changing it rebuilds the board + clears TT. */
void MR_SetCaution(int c);
/* Strength 0..100 (default 100). */
void MR_SetStrength(int s);
/* Pondering on/off (background thinking after each move). */
void MR_SetPondering(int on);
/* Swapable on/off (engine may offer swap under swap rules). */
void MR_SetSwapable(int on);

/* Clear the transposition table for a new game (per-game TT purge). */
void MR_ClearTT();

/* Reset the internal board to an empty N x N position. */
void MR_BoardReset(int size);
/* Append a move in engine coordinates (x = file, y = rank, 0-based). */
void MR_BoardMove(int x, int y);

/* Blocked-move bookkeeping (YXBLOCK equivalent). */
void MR_BlockReset();
void MR_BlockAdd(int x, int y);

/* Start an asynchronous think. Output lines arrive via the MR_Output callback.
 * multiPV > 1 asks the engine to return that many candidate moves. */
void MR_Think(int turnMs, int matchMs, int timeLeftMs, int multiPV = 1);
/* Stop the current search immediately. */
void MR_Stop();
/* 1 while a search is running. */
int  MR_Busy();

/* Synchronous balance evaluation: two=1 -> BALANCE_TWO (two candidate points),
 * bias is the engine-coordinate point already on the board (0,0 if none). */
void MR_Balance(int two, int bias);

/* Release engine resources. */
void MR_Shutdown();

#ifdef __cplusplus
}
#endif
