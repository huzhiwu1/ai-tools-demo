const foodData = {
    "Beijing": ["北京烤鸭", "北京火锅", "山东拉面"],
    "Shanghai": ["上海米粉", "上海饺子", "上海炒饭"],
    "Guangzhou": ["广州米粉", "广州点心", "广州汉堡"]
};

export function getFoodByCity({ city }) {
    const food = foodData[city];
    if (food) {
        return JSON.stringify({
            found: true,
            ...food
        })
    } else {
        return JSON.stringify({
            found: false,
            city: city
        })
    }

}
