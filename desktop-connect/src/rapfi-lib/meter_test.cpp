/*
 * Meter Gomoku - RapFi static-link smoke test.
 * Verifies the function-direct engine channel: init, board setup, think and
 * line output all run inside the host process without any pipe/process hop.
 */
#include "meter_api.h"

#include <cstdio>
#include <windows.h>

static void onEngineOut(const char *line, void * /*user*/)
{
    std::printf("[ENG] %s\n", line);
}

int main()
{
    int rc = MR_Init(L".");
    std::printf("init=%d\n", rc);
    if (rc != 0)
        return 1;

    MR_SetOutput(onEngineOut, nullptr);
    MR_SetRule(1);       // standard (no renju forbidden moves)
    MR_SetThreads(2);
    MR_SetHashMB(64);
    MR_BoardReset(15);
    MR_BoardMove(7, 7);  // tengen
    MR_Think(1000, 1000, 1000);

    for (int i = 0; i < 200 && MR_Busy(); i++)
        Sleep(50);

    MR_Shutdown();
    std::printf("done busy=%d\n", MR_Busy());
    return 0;
}
