/**
 * Copyright 2023 Tigris Data, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import platform from "../runtime/platform";
import configure from "./platform";
import { RealTime as RT, RealTimeConfig } from "../runtime/index";
export { Channel } from "../runtime/index";

configure(platform);

export class RealTime extends RT {
  constructor(options: RealTimeConfig) {
    super({ ...options, platform });
  }
}
