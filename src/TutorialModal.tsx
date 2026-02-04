import { createSignal, For } from 'solid-js';

interface TutorialModalProps {
    onClose: () => void;
}

const TutorialModal = (props: TutorialModalProps) => {
    const [currentPage, setCurrentPage] = createSignal(0);

    const pages = [
        {
            title: "Welcome to fahrtle!",
            description: "The goal of the game is to get from the start to the finish as quickly as possible. You can walk by double clicking on the map or take public transport.",
            image: "tutorial/victory.png"
        },
        {
            title: "Finding public transport",
            description: `Once you're zoomed in enough, public transport stops will be shown on the map. Stops are rainbow-coloured 🌈 by route length with purple stops having the longest routes.

            Many stops that we would consider to be a single stop, such as a railway station, are spread across multiple stops in the data. If you can't find a departure you're looking for, be sure to hunt around.
            `,
            image: "tutorial/stops.png"
        },
        {
            title: "Departures",
            description: "Clicking on the map will bring up all the departures in the highlighted area. Click the 🛂 icon circled in red to board a service, or the 🔍 icon circled in green to view the route including arrival times. The arrow to the left of the transport type shows you the bearing to the next stop.",
            image: "tutorial/departures.png"
        },
        {
            title: "Getting off at your destination",
            description: "Once you have selected a departure, click the down arrow circled in green to pick a stop to get off at. Note that the stops are in reverse order from latest to soonest.",
            image: "tutorial/alight.png"
        },
        {
            title: "Snoozing",
            description: `Time passes faster the faster you are travelling, or if you are waiting for a distant departure. If you would like to speed up time, you can snooze by clicking the 💤 button, but make sure you don't miss your stop!

            In multiplayer, time passes based on the slowest player, so it's polite to snooze wherever you can and look up departures ahead of time so people aren't waiting around for you.
            `,
            image: "tutorial/snooze.png"
        },
        {
            title: "Tips & tricks",
            description: (<>{`You can click the cog ⚙️ in the top-left to change settings. The 'infrastructure' railways layer is helpful for temporarily navigating metros in big cities and personally I prefer the Toner-like basemap to the default Positron as it shows railways very clearly.

            If you're struggling to find a way to get somewhere, it's worth looking at a stop near the destination and looking at the routes that call there via the arrivals tab on the corresponding departures board.

            Good luck, and please leave any feedback at `}<a href="https://github.com/bovine3dom/fahrtle/issues " target="_blank">https://github.com/bovine3dom/fahrtle/issues</a>!
            </>),
            image: "tutorial/settings.png"
        }
    ];

    const handleNext = () => {
        if (currentPage() < pages.length - 1) {
            setCurrentPage(currentPage() + 1);
        } else {
            props.onClose();
        }
    };

    const handlePrev = () => {
        if (currentPage() > 0) {
            setCurrentPage(currentPage() - 1);
        }
    };

    return (
        <div
            onClick={props.onClose}
            style={{
                position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
                background: 'rgba(0,0,0,0.5)', 'z-index': 1000,
                display: 'flex', 'justify-content': 'center', 'align-items': 'center',
                'backdrop-filter': 'blur(4px)'
            }}
        >
            <div
                onClick={(e) => e.stopPropagation()}
                style={{
                    background: 'white', padding: '24px', 'border-radius': '16px',
                    'box-shadow': '0 4px 20px rgba(0,0,0,0.2)',
                    'max-width': '90%', 'width': '450px',
                    'display': 'flex', 'flex-direction': 'column', 'gap': '16px'
                }}
            >
                <div style={{ 'text-align': 'center' }}>
                    <div style={{ 'font-size': '1.5rem', 'font-weight': 'bold', 'color': '#0f172a' }}>
                        {pages[currentPage()].title}
                    </div>
                    <div style={{ 'font-size': '0.9em', 'color': '#64748b', 'margin-top': '4px' }}>
                        {currentPage() + 1} / {pages.length}
                    </div>
                </div>

                <div style={{
                    width: '100%',
                    'aspect-ratio': '16/10',
                    background: '#f1f5f9',
                    'border-radius': '8px',
                    position: 'relative',
                    overflow: 'hidden',
                    border: '1px solid #e2e8f0'
                }}>
                    <For each={pages}>
                        {(page, i) => (
                            <img
                                src={page.image}
                                alt={page.title}
                                style={{
                                    position: 'absolute',
                                    top: 0,
                                    left: 0,
                                    width: '100%',
                                    height: '100%',
                                    'object-fit': 'cover',
                                    opacity: i() === currentPage() ? 1 : 0, // causes images to preload to avoid janky replacement
                                    'pointer-events': i() === currentPage() ? 'auto' : 'none'
                                }}
                            />
                        )}
                    </For>
                </div>


                <div style={{
                    'color': '#334155',
                    'font-size': '0.95em',
                    'line-height': '1.5',
                    'min-height': '60px',
                    'white-space': 'pre-line'
                }}>
                    {pages[currentPage()].description}
                </div>

                <div style={{ display: 'flex', gap: '12px', 'margin-top': '8px' }}>
                    <button
                        onClick={handlePrev}
                        disabled={currentPage() === 0}
                        style={{
                            padding: '10px 16px', background: 'white',
                            color: currentPage() === 0 ? '#cbd5e1' : '#0f172a',
                            border: '1px solid #cbd5e1',
                            'border-radius': '8px', cursor: currentPage() === 0 ? 'default' : 'pointer',
                            'font-weight': 'bold', 'font-size': '0.9em'
                        }}
                    >
                        Previous
                    </button>
                    <div style={{ flex: 1 }} />
                    <button
                        onClick={handleNext}
                        style={{
                            padding: '10px 24px',
                            background: '#3b82f6',
                            color: 'white', border: 'none',
                            'border-radius': '8px', cursor: 'pointer',
                            'font-weight': 'bold', 'font-size': '0.9em'
                        }}
                    >
                        {currentPage() === pages.length - 1 ? 'Finish' : 'Next'}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default TutorialModal;
