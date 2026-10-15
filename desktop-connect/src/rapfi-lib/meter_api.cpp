/*
 * Meter Gomoku - RapFi static-link C API implementation.
 * The engine runs inside the host process (no pipe/process boundary), shares
 * one transposition table across threads, and is driven through the exact same
 * think()/balance() protocol functions the standalone engine uses, so the
 * output lines are byte-identical to the previous channel.
 */
#include "meter_api.h"

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <iostream>
#include <limits>
#include <memory>
#include <mutex>
#include <optional>
#include <streambuf>
#include <string>
#include <utility>
#include <vector>

#include "../../rapfi/command/command.h"
#include "../../rapfi/config.h"
#include "../../rapfi/core/iohelper.h"
#include "../../rapfi/game/board.h"
#include "../../rapfi/search/opening.h"
#include "../../rapfi/search/searchengine.h"
#include "../../rapfi/search/searcher.h"
#include "../../rapfi/search/searchcommon.h"

// Protocol-level engine state (defined in command/gomocup.cpp).
namespace Command::GomocupProtocol
{
    extern std::unique_ptr<Board>         board;
    extern Search::SearchOptions          options;
    extern std::optional<CandidateRange> candRange;

    void think(Board &board,
               uint16_t                          multiPV    = 1,
               Search::SearchOptions::BalanceMode balanceMode = Search::SearchOptions::BALANCE_NONE,
               bool                               swapable   = false,
               bool                               disableOpeningQuery = false);
    void getBlock(bool remove = false);
    void setSearcherMemoryLimit(size_t maxMemSizeKB, size_t memReservedKB);
}  // namespace Command::GomocupProtocol

using Command::GomocupProtocol::board;
using Command::GomocupProtocol::options;
using Command::GomocupProtocol::candRange;

namespace {

std::mutex g_apiMu;  // serialises MR_* calls (engine state is a single instance)

/// Redirects std::cout into per-line callbacks so the host page receives the
/// exact protocol output (MESSAGE/ERROR/info/BESTMOVE/balance lines).
class EngineOutBuf : public std::streambuf
{
public:
    EngineOutBuf() = default;

    void setSink(MR_OutputFn fn, void *user)
    {
        std::lock_guard g(m_mu);
        m_fn   = fn;
        m_user = user;
    }

protected:
    int_type overflow(int_type ch) override
    {
        MR_OutputFn  fn;
        void        *user;
        std::streambuf *orig;
        std::string line;
        {
            std::lock_guard g(m_mu);
            if (ch == traits_type::eof())
                return ch;
            char c = traits_type::to_char_type(ch);
            m_line += c;
            fn   = m_fn;
            user = m_user;
            orig = m_orig;
            if (c == '\n') {
                line.swap(m_line);  // flush complete line outside the lock
                m_line.clear();
            }
        }
        if (!line.empty()) {
            while (!line.empty() && (line.back() == '\n' || line.back() == '\r'))
                line.pop_back();
            if (fn)
                fn(line.c_str(), user);
        }
        if (orig)
            orig->sputc(traits_type::to_char_type(ch));
        return ch;
    }

private:
    std::mutex    m_mu;
    std::string   m_line;
    std::streambuf *m_orig  = nullptr;
    MR_OutputFn   m_fn   = nullptr;
    void         *m_user = nullptr;
};

EngineOutBuf     g_outBuf;
std::streambuf  *g_origCout = nullptr;
std::atomic<bool> g_inited{false};

int clampThreads(int n)
{
    return std::max(n, 1);
}

}  // namespace

// --------------------------------------------------------------- init / io

int MR_Init(const wchar_t *exeDir)
{
    std::lock_guard g(g_apiMu);
    if (g_inited)
        return 0;
    try {
        (void)exeDir;  // binaryDirectory is resolved from the host module path
        Command::CommandLine::init(0, nullptr);
        Command::configPath          = Command::CommandLine::binaryDirectory / L"config.toml";
        Command::allowInternalConfig = false;
        if (!Command::loadConfig())
            return 2;  // config.toml missing or invalid
        g_origCout = std::cout.rdbuf(&g_outBuf);
        g_inited  = true;
        return 0;
    }
    catch (...) {
        return 3;  // unexpected engine init failure
    }
}

void MR_SetOutput(MR_OutputFn fn, void *user)
{
    g_outBuf.setSink(fn, user);
}

void MR_Shutdown()
{
    std::lock_guard g(g_apiMu);
    if (!g_inited)
        return;
    Search::Engine.stopThinking();
    Search::Engine.waitForIdle();
    Search::Engine.clear(false);
    if (g_origCout)
        std::cout.rdbuf(g_origCout);
    g_inited = false;
}

// ------------------------------------------------------------- settings

void MR_SetRule(int rule)
{
    std::lock_guard g(g_apiMu);
    Rule prevRule = options.rule;
    switch (rule) {
    case 0: options.rule = {Rule::FREESTYLE, GameRule::FREEOPEN}; break;
    case 1: options.rule = {Rule::STANDARD, GameRule::FREEOPEN}; break;
    case 2:  // Yixin-Board extension id
    case 4: options.rule = {Rule::RENJU, GameRule::FREEOPEN}; break;
    case 5: options.rule = {Rule::FREESTYLE, GameRule::SWAP1}; break;
    case 6: options.rule = {Rule::FREESTYLE, GameRule::SWAP2}; break;
    default: options.rule = {Rule::FREESTYLE, GameRule::FREEOPEN}; break;
    }
    if (board && prevRule != options.rule) {
        board->newGame(options.rule);
        Search::Engine.clear(true);
    }
}

void MR_SetThreads(int n)
{
    std::lock_guard g(g_apiMu);
    int64_t val = clampThreads(n);
    if (Search::Engine.size() != val)
        Search::Engine.setNumThreads(val);
}

void MR_SetHashMB(int mb)
{
    std::lock_guard g(g_apiMu);
    // Yixin-Board HASH_SIZE semantics: the value is the TT budget in KiB.
    size_t maxMemSizeKB = mb > 0 ? (size_t)mb * 1024 : 32768;
    Command::GomocupProtocol::setSearcherMemoryLimit(maxMemSizeKB, 0);
}

void MR_SetCaution(int c)
{
    std::lock_guard g(g_apiMu);
    auto prev = candRange;
    switch (c) {
    case 0: candRange = CandidateRange::SQUARE2; break;
    case 1: candRange = CandidateRange::SQUARE2_LINE3; break;
    case 2: candRange = CandidateRange::SQUARE3; break;
    case 3: candRange = CandidateRange::SQUARE3_LINE4; break;
    case 4: candRange = CandidateRange::SQUARE4; break;
    default: candRange = CandidateRange::FULL_BOARD; break;
    }
    // Rebuild the board to match the new candidate range, then purge TT.
    if (board && (!prev.has_value() || *prev != *candRange)) {
        std::vector<Pos> history;
        history.reserve(board->ply());
        for (int i = 0; i < board->ply(); i++)
            history.push_back(board->getHistoryMove(i));
        auto candidateRange = *candRange;
        board               = std::make_unique<Board>(board->size(), candidateRange);
        board->newGame(options.rule);
        for (Pos p : history)
            board->move(options.rule, p);
        Search::Engine.clear(true);
    }
}

void MR_SetStrength(int s)
{
    std::lock_guard g(g_apiMu);
    options.strengthLevel = std::clamp(s, 0, 100);
}

void MR_SetPondering(int on)
{
    std::lock_guard g(g_apiMu);
    options.pondering = on != 0;
}

void MR_SetSwapable(int on)
{
    std::lock_guard g(g_apiMu);
    options.swapable = on != 0;
}

void MR_ClearTT()
{
    std::lock_guard g(g_apiMu);
    Search::Engine.waitForIdle();
    Search::Engine.clear(true);
}

// -------------------------------------------------------------- board

void MR_BoardReset(int size)
{
    std::lock_guard g(g_apiMu);
    Search::Engine.stopThinking();
    Search::Engine.waitForIdle();
    if (!board || board->size() != size) {
        auto candidateRange = candRange.value_or(Config::GeneralCfg.defaultCandidateRange);
        board               = std::make_unique<Board>(size, candidateRange);
    }
    board->newGame(options.rule);
}

void MR_BoardMove(int x, int y)
{
    std::lock_guard g(g_apiMu);
    Search::Engine.waitForIdle();
    options.multiPV     = 1;
    options.balanceMode = Search::SearchOptions::BALANCE_NONE;
    // protocol coords -> internal (X_flipY io mode, same as gomocup YXBOARD)
    board->move(options.rule, Pos(x, (int)board->size() - 1 - y));
}

void MR_BlockReset()
{
    std::lock_guard g(g_apiMu);
    options.blockMoves.clear();
}

void MR_BlockAdd(int x, int y)
{
    std::lock_guard g(g_apiMu);
    // protocol coords -> internal (X_flipY io mode, same as gomocup YXBLOCK)
    Pos pos(x, (int)board->size() - 1 - y);
    if (std::count(options.blockMoves.begin(), options.blockMoves.end(), pos) == 0)
        options.blockMoves.push_back(pos);
}

// ------------------------------------------------------------- search

void MR_Think(int turnMs, int matchMs, int timeLeftMs, int multiPV)
{
    std::lock_guard g(g_apiMu);
    options.timeLimit = true;
    options.setTimeControl(turnMs, matchMs);
    options.timeLeft = timeLeftMs > 0 ? timeLeftMs : std::numeric_limits<Time>::max();
    Command::GomocupProtocol::think(*board, (uint16_t)std::max(1, multiPV));
}

void MR_Stop()
{
    std::lock_guard g(g_apiMu);
    Search::Engine.stopThinking();
}

int MR_Busy()
{
    return Search::Engine.ctx.inPonder.load() ? 1 : 0;
}

void MR_Balance(int two, int bias)
{
    std::lock_guard g(g_apiMu);
    auto mode = two ? Search::SearchOptions::BALANCE_TWO : Search::SearchOptions::BALANCE_ONE;
    options.balanceBias = bias;
    if (mode == Search::SearchOptions::BALANCE_TWO)
        options.balanceBias = -options.balanceBias;
    if (board->ply() == 0)
        Opening::expandCandidateHalfBoard(*board);
    Command::GomocupProtocol::think(*board, 1, mode, false, true);
}
