// 内置城市表（用于定位最近城市匹配与城市下拉）
export interface CityEntry {
  name: string;
  lat: number;
  lng: number;
}

export const CITIES: CityEntry[] = [
  { name: '北京', lat: 39.904, lng: 116.407 },
  { name: '上海', lat: 31.230, lng: 121.474 },
  { name: '广州', lat: 23.129, lng: 113.264 },
  { name: '深圳', lat: 22.543, lng: 114.058 },
  { name: '成都', lat: 30.573, lng: 104.067 },
  { name: '杭州', lat: 30.274, lng: 120.155 },
  { name: '武汉', lat: 30.593, lng: 114.305 },
  { name: '西安', lat: 34.341, lng: 108.940 },
  { name: '南京', lat: 32.060, lng: 118.797 },
  { name: '重庆', lat: 29.564, lng: 106.551 },
  { name: '天津', lat: 39.084, lng: 117.201 },
  { name: '苏州', lat: 31.299, lng: 120.585 },
  { name: '长沙', lat: 28.228, lng: 112.939 },
  { name: '郑州', lat: 34.747, lng: 113.625 },
  { name: '青岛', lat: 36.067, lng: 120.383 },
  { name: '合肥', lat: 31.821, lng: 117.227 },
  { name: '福州', lat: 26.074, lng: 119.297 },
  { name: '厦门', lat: 24.479, lng: 118.089 },
  { name: '昆明', lat: 24.880, lng: 102.833 },
  { name: '大连', lat: 38.914, lng: 121.615 },
  { name: '沈阳', lat: 41.806, lng: 123.432 },
  { name: '哈尔滨', lat: 45.803, lng: 126.535 },
  { name: '济南', lat: 36.651, lng: 117.120 },
  { name: '宁波', lat: 29.868, lng: 121.544 },
  { name: '无锡', lat: 31.491, lng: 120.312 },
  { name: '佛山', lat: 23.022, lng: 113.122 },
  { name: '东莞', lat: 23.021, lng: 113.752 },
  { name: '温州', lat: 28.000, lng: 120.699 },
  { name: '石家庄', lat: 38.042, lng: 114.515 },
  { name: '南昌', lat: 28.682, lng: 115.858 },
  { name: '贵阳', lat: 26.647, lng: 106.630 },
  { name: '南宁', lat: 22.817, lng: 108.366 },
  { name: '太原', lat: 37.870, lng: 112.549 },
  { name: '长春', lat: 43.817, lng: 125.324 },
  { name: '兰州', lat: 36.061, lng: 103.834 },
  { name: '海口', lat: 20.044, lng: 110.199 },
];

export function nearestCity(lat: number, lng: number): { city: CityEntry; distanceKm: number } {
  let best = CITIES[0];
  let bestD = Number.POSITIVE_INFINITY;
  for (const c of CITIES) {
    const dKm = haversineKm(lat, lng, c.lat, c.lng);
    if (dKm < bestD) { bestD = dKm; best = c; }
  }
  return { city: best, distanceKm: bestD };
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
