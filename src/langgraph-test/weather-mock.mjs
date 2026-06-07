const weatherData = {
    "Beijing": {
        weather: "晴朗",
        temperature: "25°C",
        humidity: "80%"
    },
    "Shanghai": {
        weather: "多云",
        temperature: "22°C",
        humidity: "75%"
    },
    "Guangzhou": {
        weather: "阴天",
        temperature: "20°C",
        humidity: "90%"
    }
};
export function getWeatherByCity({ city }) {
    const weather = weatherData[city];
    if (weather) {
        return JSON.stringify({
            found: true,
            ...weather
        })
    } else {
        return JSON.stringify({
            found: false,
            city: city
        })
    }
}