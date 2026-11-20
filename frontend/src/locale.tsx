import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

const english = {
  '校园垃圾分类与清运': 'Campus waste and collection',
  'Campus Loop 校园分类': 'Campus Loop | Waste Sorting',
  '语言': 'Language',
  '页面切换': 'Page navigation',
  '跳到主要区域': 'Skip to main content',
  '学生投放': 'Sorting',
  '校园分类投放': 'Campus Waste Sorting',
  '保洁工作台': 'Collection Console',
  '宿舍区': 'Residence area',
  '识别手中的物品，获取当前可用的投放位置。': 'Identify an item and find an available bin.',
  '查看满桶工单与推荐清运顺序。': 'Review full-bin tickets and the recommended next stop.',
  '桶位与工单实时同步': 'Bin and ticket status sync automatically',
  '状态已同步': 'Synced',
  '连接中断': 'Disconnected',
  '正在连接': 'Connecting',
  '当前投放站点': 'Current station',
  '选择站点': 'Select a station',
  '桶位状态待重新连接确认。': 'Bin status will refresh when the connection returns.',
  '宿舍 A 站': 'Residence Station A',
  '宿舍 B 站': 'Residence Station B',
  '宿舍 C 站': 'Residence Station C',
  '宿舍区主入口': 'Residence main entrance',
  '宿舍区连廊': 'Residence walkway',
  '宿舍区南侧通道': 'South residence passage',
  '设备模拟器': 'Device Simulator',
  '组内登录': 'Team Sign-in',
  '登录后可以操作设备、清运工单和使用在线模型。': 'Sign in to report sensor events, manage collection tickets, and use live AI.',
  '组内口令': 'Team access code',
  '关闭登录': 'Close sign-in',
  '退出组内访问': 'Sign out of team access',
  '登录': 'Sign In',
  '正在登录…': 'Signing in…',
  '请先进行组内登录。': 'Sign in with the team access code first.',
  '组内口令不正确。': 'The team access code is incorrect.',
  '向后端上报模拟红外状态': 'Send simulated infrared sensor readings',
  '关闭模拟器': 'Close simulator',
  '模拟站点': 'Station',
  '模拟桶位': 'Bin category',
  '后端当前状态': 'Current bin status',
  '上报已满': 'Report Full',
  '再次上报已满': 'Report Full Again',
  '上报未满': 'Report Available',
  '模拟设备离线': 'Simulate Offline',
  '已上报{station}的{category}桶，状态为{status}。': '{category} at {station} reported as {status}.',
  '重置演示数据': 'Reset Demo Data',
  '清空演示工单，恢复全部示范桶位。': 'Clear demo tickets and mark all bins available.',
  '演示数据已复位。': 'Demo data has been reset.',
  '可回收物': 'Recyclables',
  '厨余垃圾': 'Food waste',
  '其他垃圾': 'Residual waste',
  '有害垃圾': 'Hazardous waste',
  '可投放': 'Available',
  '已满': 'Full',
  '未知': 'Unknown',
  '待清运': 'Pending',
  '待传感器确认': 'Awaiting sensor check',
  '仍报满，待复核': 'Still full, needs review',
  '已关闭': 'Closed',
  '空饮料瓶': 'Empty drink bottle',
  '带盖饮料杯': 'Lidded drink cup',
  '外带饮料杯': 'Takeaway cup',
  '用过的纸巾': 'Used tissue',
  '香蕉皮': 'Banana peel',
  '废电池': 'Used battery',
  '待确认物品': 'Unidentified item',
  '请确认杯内是否还有剩液，并按现场标识分开处理杯体与内容物。': 'Check for liquid in the cup and use the station labels to dispose of the cup and its contents separately.',
  '请把一件物品放在画面中央，并拍清楚它的材质和内容物。': 'Center one item and make sure its material and contents are clearly visible.',
  '投放指引': 'Where to Sort',
  '等待站点连接': 'Waiting for station data',
  'JEV 识别': 'JEV result',
  '等待物品识别': 'Ready to scan',
  '先识别，再投放': 'Identify an item first',
  '识别后查看桶位指引。': 'Your sorting directions will appear here.',
  '请投{category}': 'Use the {category} bin',
  '请前往 {station}': 'Go to {station}',
  '暂不可投放': 'No bin available',
  '需要进一步确认': 'Please check the item',
  '请将物品投进亮灯的桶口。': 'Put the item in the highlighted bin.',
  '本站同类桶已满。': 'This station’s bin for that category is full.',
  '本站同类桶暂不可用。': 'This station’s bin for that category is unavailable.',
  '{detail}的同类桶可用。': 'A bin for this category is available at the {detail}.',
  '附近没有可用的同类桶，请稍后再投。': 'No nearby bin is available for this category. Try again later.',
  '暂时无法确认桶位，请稍后再试。': 'Bin availability is unknown. Try again shortly.',
  '请把物品单独摆放，拍清楚后再识别。': 'Place the item on its own and take a clearer photo.',
  '本站桶位': 'Bins at This Station',
  '高亮桶位为推荐投放点': 'Use the highlighted bin',
  '本站': 'This station',
  '{name}（{detail}）': '{name} ({detail})',
  '已亮灯': 'Light on',
  '未亮灯': 'Light off',
  '投这里': 'Use this bin',
  '物品识别': 'Item Recognition',
  '每次拍摄或上传一件物品': 'Capture or upload one item at a time',
  '图像来源': 'Image source',
  '样例': 'Examples',
  '上传文件': 'Upload',
  '正在打开': 'Opening…',
  '摄像头': 'Camera',
  '选择图片或视频': 'Choose an image or video',
  '当前待识别的物品': 'Item to identify',
  '摄像头实时画面': 'Live camera preview',
  'JEV 实时推理': 'Live JEV',
  '关闭摄像头': 'Close camera',
  '选择样例': 'Choose an example item',
  '把进度条拉到物品清楚的画面，再点击截帧识别。': 'Find a frame where the item is clear, then select Identify Frame.',
  '点击识别后，单张图像将发送至 JEV 接口。': 'Identifying an item sends one image to JEV.',
  '处理中…': 'Processing…',
  '截帧识别': 'Identify Frame',
  '识别图片': 'Identify Image',
  '相机截图': 'Camera frame',
  '还没有可用画面，请稍候或播放视频。': 'No frame is available yet. Wait or play the video.',
  '浏览器无法处理图像。': 'The browser could not process the image.',
  '请选择浏览器可读取的图片或视频文件。': 'Choose an image or video your browser can open.',
  '无法打开该文件，请试试 JPEG、PNG 或 MP4。': 'Could not open that file. Try JPEG, PNG, or MP4.',
  '摄像头需要通过 localhost 或 HTTPS 访问，也可上传图片或录像。': 'Camera access requires localhost or HTTPS. You can also upload a photo or video.',
  '无法使用摄像头，请检查授权和设备，或上传图片和视频。': 'Check camera permissions or upload an image or video.',
  '等画面出现后再截帧识别。': 'Wait for the preview before identifying a frame.',
  '浏览器无法播放该视频，请上传 MP4 文件。': 'The browser could not play this video. Try an MP4 file.',
  '下一站': 'Next Stop',
  '当前唯一可执行的清运任务': 'The only ticket ready for collection',
  '等待时间靠前，优先处理': 'This ticket has waited the longest',
  '等待时间相近，优先处理较近的站点': 'Closest station among tickets with similar wait times',
  '已等待 {time}': 'Waiting {time}',
  '{status}，已等待 {time}': '{status}, waiting {time}',
  '不足 1 分钟': 'under 1 min',
  '{minutes} 分钟': '{minutes} min',
  '{hours} 小时 {minutes} 分钟': '{hours} h {minutes} min',
  '确认已清运': 'Confirm Collection',
  '暂无清运任务': 'No collection tasks',
  '等待后端连接': 'Connecting to the server',
  '当前工单正在等待桶位重新上报。': 'Existing tickets are waiting for a new bin reading.',
  '收到满桶上报后，这里会显示建议处理的站点。': 'The next stop will appear when a bin reports full.',
  '清运工单': 'Collection Tickets',
  '{count} 条进行中': '{count} open',
  '暂无进行中的工单': 'No open tickets',
  '等待工单同步': 'Waiting for tickets',
  '优先': 'Priority',
  '标记已清运': 'Mark Collected',
  '有满桶': 'Full bin',
  '有设备未知': 'Sensor status unknown',
  '港科大（广州）校园点位图': 'HKUST(GZ) Campus Map',
  '{count} 个投放站点': '{count} sorting stations',
  '只看异常': 'Issues Only',
  '{station} 站': 'Station {station}',
  '校园示意图（非测绘比例）': 'Campus schematic (not to scale)',
  '校方地图': 'Official Map',
  '推荐下一站': 'Recommended stop',
  '当前没有异常站点。': 'No stations with issues.',
  '图书馆': 'Library',
  '食堂': 'Canteen',
  '演讲厅': 'Lecture Halls',
  '行政大楼': 'Administration',
  '活动中心': 'Activity Center',
  '体育场': 'Stadium',
  '体育馆': 'Sports Hall',
  '体育区': 'Sports Area',
  '教学科研区': 'Academic Area',
  '南区宿舍': 'South Residences',
  '主入口': 'Main Entrance',
  '笃学路': 'Duxue Road',
  '清运分析': 'Collection Analysis',
  '按工单创建时间统计': 'Based on when tickets were opened',
  '分析时间范围': 'Reporting period',
  '近 {days} 天': 'Last {days} days',
  '正在分析…': 'Analyzing…',
  '生成分析': 'Generate Analysis',
  '本地规则': 'Local rules',
  'DeepSeek（{model}）': 'DeepSeek ({model})',
  '{start} 至 {end}（北京时间）': '{start} to {end} (Beijing time)',
  '满桶工单': 'Full-Bin Tickets',
  '等待至少 20 分钟': 'Waiting 20+ Minutes',
  '平均关闭耗时': 'Average Time to Close',
  '来自 {count} 条带关闭时间的工单': 'Timed tickets: {count}',
  '清运建议': 'Collection Recommendations',
  '依据': 'Evidence',
  '正在汇总工单与复核状态。': 'Summarizing tickets and verification status.',
  '等待后端连接。': 'Waiting for the server.',
  '请求超时，请重试。': 'The request timed out. Try again.',
  '连接失败，请检查后端服务。': 'Could not reach the server. Check that it is running.',
  '服务暂时不可用，请重试。': 'The service is unavailable. Try again.',
  '正在处理上一条指令，请稍候。': 'The previous action is still running. Please wait.',
  '无法访问状态库': 'Could not access the database.',
  '状态库操作失败': 'The database operation failed.',
  '请求 JSON 格式错误或内容过大': 'The request is invalid or too large.',
  '找不到该接口': 'Endpoint not found.',
  '找不到该投放点': 'Station not found.',
  '找不到该工单': 'Ticket not found.',
  '找不到该桶位': 'Bin not found.',
  '事件 ID 长度应为 1–128 字节': 'An event ID must contain 1–128 bytes.',
  '无效的设备时间戳': 'Invalid sensor timestamp.',
  '同一事件 ID 已用于另一条上报': 'This event ID belongs to another report.',
  '请选择一个演示录像样例': 'Choose a demo sample.',
  'JEV 实时识别尚未配置。请检查服务端 API 密钥，或选择演示回放。': 'Live JEV is unavailable. Configure the server API key or use a demo sample.',
  '请先拍摄或选择图片': 'Capture or choose an image first.',
  'JEV 识别请求超时': 'The JEV request timed out.',
  '无法连接 JEV 识别服务': 'Could not reach JEV.',
  'JEV 拒绝了服务端鉴权，请检查密钥权限': 'JEV rejected the server credentials. Check the API key.',
  'JEV 请求达到服务限额，请稍后再试': 'The JEV limit was reached. Try again later.',
  '当前运行地区无法访问 JEV 识别服务': 'JEV is unavailable in the server’s region.',
  'JEV 识别服务返回错误': 'JEV returned an error.',
  '请使用 JPEG 或 PNG 图片': 'Choose a JPEG or PNG image.',
  '图片不得超过 1 MB': 'Images must be 1 MB or smaller.',
  '图片 Base64 编码错误': 'The image encoding is invalid.',
  '实际图片格式与文件标记不符': 'The image format does not match the file label.',
  'JEV 返回的识别字段不完整或不符合预期': 'JEV returned an incomplete or invalid result.',
  '仅支持近 7 天或近 28 天': 'Choose the last 7 or 28 days.',
} as const;

export type Language = 'zh-CN' | 'en';
export type Message = keyof typeof english;
type Values = Record<string, string | number>;

function translate(language: Language, message: string, values?: Values) {
  const text = language === 'en' && Object.hasOwn(english, message) ? english[message as Message] : message;
  return values ? text.replace(/\{(\w+)\}/g, (token, key: string) => String(values[key] ?? token)) : text;
}

export type Translator = (message: Message, values?: Values) => string;

type Locale = {
  language: Language;
  setLanguage: (language: Language) => void;
  t: Translator;
  text: (message: string) => string;
};

const languageKey = 'campus-loop-language';
const LocaleContext = createContext<Locale | null>(null);

function savedLanguage(): Language {
  try { return localStorage.getItem(languageKey) === 'en' ? 'en' : 'zh-CN'; }
  catch { return 'zh-CN'; }
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<Language>(savedLanguage);
  const locale = useMemo<Locale>(() => ({
    language,
    setLanguage,
    t: (message, values) => translate(language, message, values),
    text: (message) => translate(language, message),
  }), [language]);

  useEffect(() => {
    document.documentElement.lang = language;
    document.title = translate(language, 'Campus Loop 校园分类');
    try { localStorage.setItem(languageKey, language); }
    catch { /* The selection still works when storage is unavailable. */ }
  }, [language]);

  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useLocale() {
  const locale = useContext(LocaleContext);
  if (!locale) throw new Error('LocaleProvider is required');
  return locale;
}
