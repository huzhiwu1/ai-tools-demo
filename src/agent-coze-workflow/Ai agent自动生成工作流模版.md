# Ai agent自动生成工作流模版

# coze工作流的接口

1. 创建工作流的接口

curl \-\-url 'https://coze\.dev1\.dachensky\.com/api/workflow\_api/create' \\

\-H 'Accept: application/json, text/plain, \*/\*' \\

\-H 'Accept\-Language: zh\-CN,zh;q=0\.9,en;q=0\.8' \\

\-H 'Agw\-Js\-Conv: str' \\

\-H 'Connection: keep\-alive' \\

\-H 'Content\-Type: application/json' \\

\-b 'i18next=zh\-CN; session\_key=eyJpZCI6NzY3Mjc4MjE2OTI1MjU2MDg5NiwiY3JlYXRlZF9hdCI6IjIwMjYtMDgtMTFUMjI6MzM6MzEuMDg3ODc5NjA2KzA4OjAwIiwiZXhwaXJlc19hdCI6IjIwMjYtMDgtMTJUMjI6MzM6MzEuMDg3ODc5Njg0KzA4OjAwIn2wsdUOZW0Z5tu\_dX6RZFMWEoamtK\_0GfziURd6ZJkQng' \\

\-H 'Origin: https://coze\.dev1\.dachensky\.com' \\

\-H 'Referer: https://coze\.dev1\.dachensky\.com/space/7560621359533916160/project?tab=workflow' \\

\-H 'Sec\-Fetch\-Dest: empty' \\

\-H 'Sec\-Fetch\-Mode: cors' \\

\-H 'Sec\-Fetch\-Site: same\-origin' \\

\-H 'User\-Agent: Mozilla/5\.0 \(Macintosh; Intel Mac OS X 10\_15\_7\) AppleWebKit/537\.36 \(KHTML, like Gecko\) Chrome/151\.0\.0\.0 Safari/537\.36' \\

\-H 'sec\-ch\-ua: "Not=A?Brand";v="99", "Google Chrome";v="151", "Chromium";v="151"' \\

\-H 'sec\-ch\-ua\-mobile: ?0' \\

\-H 'sec\-ch\-ua\-platform: "macOS"' \\

\-H 'x\-locale: zh\-CN' \\

\-H 'x\-requested\-with: XMLHttpRequest' \\

\-\-data\-raw '\{"name":"test\_auto\_workflow","desc":"测试","icon\_uri":"default\_icon/default\_workflow\_icon\.png","space\_id":"7560621359533916160","flow\_mode":0\}'
返回的数据结构

\{

"data": \{

"workflow\_id": "7672788276343734272",

"name": "",

"url": "",

"status": 0,

"type": 0,

"node\_list": null

\},

"code": 0,

"msg": "",

"BaseResp": null

\}

2. 保存节点的接口

curl \-\-url 'https://coze\.dev1\.dachensky\.com/api/workflow\_api/save' \\

\-H 'Accept: application/json, text/plain, \*/\*' \\

\-H 'Accept\-Language: zh\-CN,zh;q=0\.9,en;q=0\.8' \\

\-H 'Agw\-Js\-Conv: str' \\

\-H 'Connection: keep\-alive' \\

\-H 'Content\-Type: application/json' \\

\-b 'i18next=zh\-CN; session\_key=eyJpZCI6NzY3Mjc4MjE2OTI1MjU2MDg5NiwiY3JlYXRlZF9hdCI6IjIwMjYtMDgtMTFUMjI6MzM6MzEuMDg3ODc5NjA2KzA4OjAwIiwiZXhwaXJlc19hdCI6IjIwMjYtMDgtMTJUMjI6MzM6MzEuMDg3ODc5Njg0KzA4OjAwIn2wsdUOZW0Z5tu\_dX6RZFMWEoamtK\_0GfziURd6ZJkQng' \\

\-H 'Origin: https://coze\.dev1\.dachensky\.com' \\

\-H 'Referer: https://coze\.dev1\.dachensky\.com/work\_flow?workflow\_id=7672783518455300096\&space\_id=7560621359533916160' \\

\-H 'Sec\-Fetch\-Dest: empty' \\

\-H 'Sec\-Fetch\-Mode: cors' \\

\-H 'Sec\-Fetch\-Site: same\-origin' \\

\-H 'User\-Agent: Mozilla/5\.0 \(Macintosh; Intel Mac OS X 10\_15\_7\) AppleWebKit/537\.36 \(KHTML, like Gecko\) Chrome/151\.0\.0\.0 Safari/537\.36' \\

\-H 'sec\-ch\-ua: "Not=A?Brand";v="99", "Google Chrome";v="151", "Chromium";v="151"' \\

\-H 'sec\-ch\-ua\-mobile: ?0' \\

\-H 'sec\-ch\-ua\-platform: "macOS"' \\

\-H 'x\-requested\-with: XMLHttpRequest' \\

\-\-data\-raw '\{"workflow\_id":"7672783518455300096","schema":"\{\\"nodes\\":\[\{\\"id\\":\\"100001\\",\\"type\\":\\"1\\",\\"meta\\":\{\\"position\\":\{\\"x\\":0,\\"y\\":0\}\},\\"data\\":\{\\"nodeMeta\\":\{\\"description\\":\\"工作流的起始节点，用于设定启动工作流需要的信息\\",\\"icon\\":\\"https://lf3\-static\.bytednsdoc\.com/obj/eden\-cn/dvsmryvd\_avi\_dvsm/ljhwZthlaukjlkulzlp/icon/icon\-Start\-v2\.jpg\\",\\"subTitle\\":\\"\\",\\"title\\":\\"开始\\"\},\\"outputs\\":\[\{\\"type\\":\\"string\\",\\"name\\":\\"input\\",\\"required\\":false\}\],\\"trigger\_parameters\\":\[\]\}\},\{\\"id\\":\\"900001\\",\\"type\\":\\"2\\",\\"meta\\":\{\\"position\\":\{\\"x\\":1000,\\"y\\":0\}\},\\"data\\":\{\\"nodeMeta\\":\{\\"description\\":\\"工作流的最终节点，用于返回工作流运行后的结果信息\\",\\"icon\\":\\"https://lf3\-static\.bytednsdoc\.com/obj/eden\-cn/dvsmryvd\_avi\_dvsm/ljhwZthlaukjlkulzlp/icon/icon\-End\-v2\.jpg\\",\\"subTitle\\":\\"\\",\\"title\\":\\"结束\\"\},\\"inputs\\":\{\\"terminatePlan\\":\\"returnVariables\\",\\"inputParameters\\":\[\{\\"name\\":\\"output\\",\\"input\\":\{\\"type\\":\\"string\\",\\"value\\":\{\\"type\\":\\"ref\\",\\"content\\":\{\\"source\\":\\"block\-output\\",\\"blockID\\":\\"\\",\\"name\\":\\"\\"\}\}\}\}\]\}\}\},\{\\"id\\":\\"147207\\",\\"type\\":\\"43\\",\\"meta\\":\{\\"position\\":\{\\"x\\":478\.83333333333326,\\"y\\":\-13\.700000000000003\}\},\\"data\\":\{\\"inputs\\":\{\\"databaseInfoList\\":\[\],\\"selectParam\\":\{\\"condition\\":\{\\"logic\\":\\"OR\\"\}\}\},\\"outputs\\":\[\{\\"type\\":\\"list\\",\\"name\\":\\"outputList\\",\\"schema\\":\{\\"type\\":\\"object\\",\\"schema\\":\[\]\}\},\{\\"type\\":\\"integer\\",\\"name\\":\\"rowNum\\"\}\],\\"nodeMeta\\":\{\\"title\\":\\"查询数据\\",\\"icon\\":\\"https://lf3\-static\.bytednsdoc\.com/obj/eden\-cn/dvsmryvd\_avi\_dvsm/ljhwZthlaukjlkulzlp/icon/icaon\-database\-select\.jpg\\",\\"description\\":\\"从表获取数据，用户可定义查询条件、选择列等，输出符合条件的数据\\",\\"mainColor\\":\\"\#F2B600\\",\\"subTitle\\":\\"查询数据\\"\}\}\}\],\\"edges\\":\[\{\\"sourceNodeID\\":\\"100001\\",\\"targetNodeID\\":\\"147207\\"\}\],\\"versions\\":\{\\"loop\\":\\"v2\\"\}\}","space\_id":"7560621359533916160","submit\_commit\_id":"7672784418561327104","ignore\_status\_transfer":false\}'

返回的数据结构：

\{

"data": \{

"name": "",

"url": "",

"status": 0,

"workflow\_status": 0,

"remaining\_ttl": 900

\},

"code": 0,

"msg": "",

"BaseResp": null

\}

3. 试运行接口

curl \-\-url 'https://coze\.dev1\.dachensky\.com/api/workflow\_api/test\_run' \\

\-H 'Accept: application/json, text/plain, \*/\*' \\

\-H 'Accept\-Language: zh\-CN,zh;q=0\.9,en;q=0\.8' \\

\-H 'Agw\-Js\-Conv: str' \\

\-H 'Connection: keep\-alive' \\

\-H 'Content\-Type: application/json' \\

\-b 'i18next=zh\-CN; session\_key=eyJpZCI6NzY3Mjc4MjE2OTI1MjU2MDg5NiwiY3JlYXRlZF9hdCI6IjIwMjYtMDgtMTFUMjI6MzM6MzEuMDg3ODc5NjA2KzA4OjAwIiwiZXhwaXJlc19hdCI6IjIwMjYtMDgtMTJUMjI6MzM6MzEuMDg3ODc5Njg0KzA4OjAwIn2wsdUOZW0Z5tu\_dX6RZFMWEoamtK\_0GfziURd6ZJkQng' \\

\-H 'Origin: https://coze\.dev1\.dachensky\.com' \\

\-H 'Referer: https://coze\.dev1\.dachensky\.com/work\_flow?workflow\_id=7672783518455300096\&space\_id=7560621359533916160' \\

\-H 'Sec\-Fetch\-Dest: empty' \\

\-H 'Sec\-Fetch\-Mode: cors' \\

\-H 'Sec\-Fetch\-Site: same\-origin' \\

\-H 'User\-Agent: Mozilla/5\.0 \(Macintosh; Intel Mac OS X 10\_15\_7\) AppleWebKit/537\.36 \(KHTML, like Gecko\) Chrome/151\.0\.0\.0 Safari/537\.36' \\

\-H 'rpc\-persist\-mock\-traffic\-enable: 1' \\

\-H 'sec\-ch\-ua: "Not=A?Brand";v="99", "Google Chrome";v="151", "Chromium";v="151"' \\

\-H 'sec\-ch\-ua\-mobile: ?0' \\

\-H 'sec\-ch\-ua\-platform: "macOS"' \\

\-H 'x\-requested\-with: XMLHttpRequest' \\

\-\-data\-raw '\{"workflow\_id":"7672783518455300096","input":\{"input":"11"\},"space\_id":"7560621359533916160","commit\_id":""\}'
返回的数据结构：

\{

"data": \{

"workflow\_id": "7672783518455300096",

"execute\_id": "7672785536574029824",

"session\_id": ""

\},

"code": 0,

"msg": "",

"BaseResp": null

\}

