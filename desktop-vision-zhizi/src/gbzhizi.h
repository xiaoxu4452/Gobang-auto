/* Vision-zhizi - gbzhizi.h. Readboard-style (Zhizi) stone classifier. */

#pragma once

#include "gbvision.h"

namespace gb {

/* Readboard three-stage classifier: neutral-gray gate + black/white ratio
   over each intersection window + white double-check. Same signature as
   readStonesAdaptive so it can swap in/out of the scan pipeline. */
void readStonesZhizi(const cv::Mat& rgb, const GeoLike& geo,
                     cv::Mat& board, cv::Mat& conf, Json& diag);

}  // namespace gb
