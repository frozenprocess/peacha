package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net"

	"github.com/projectcalico/calico/felix/calc"
	"github.com/projectcalico/calico/felix/config"
	"github.com/projectcalico/calico/lib/std/uniquelabels"
	"github.com/projectcalico/calico/libcalico-go/lib/backend/api"
	"github.com/projectcalico/calico/libcalico-go/lib/backend/k8s/conversion"
	"github.com/projectcalico/calico/libcalico-go/lib/backend/model"
	calinet "github.com/projectcalico/calico/libcalico-go/lib/net"
)

const numNamespaces = 2

func main() {

	Init()
}

func Init() {
	conf := config.New()
	conf.FelixHostname = "localhost"
	es := calc.NewEventSequencer(conf)
	cg := calc.NewCalculationGraph(es, nil, conf, func() {})
	epUpdates := makeEndpointUpdates(2, "localhost")
	sendEndpointUpdates(cg, epUpdates)
	TiUpdates := makeTierUpdates(1, "default")
	sendEndpointUpdates(cg, TiUpdates)

	// rulescanner to match labels
	// if that is successfull then policy matcher should be called

	fmt.Println(cg)
}

func sendEndpointUpdates(cg *calc.CalcGraph, epUpdates []api.Update) {
	cg.AllUpdDispatcher.OnUpdates(epUpdates)
}

func makeTierUpdates(num int, name string) []api.Update {
	updates := make([]api.Update, num)

	for n := 0; n < num; n++ {
		key := model.TierKey{
			Name: name,
		}
		order := 100.0
		updates[n] = api.Update{
			KVPair: model.KVPair{
				Key: key,
				Value: &model.Tier{
					Order:         &order,
					DefaultAction: "Drop",
				},
			},
		}
	}
	return updates
}

func makeEndpointUpdates(num int, host string) []api.Update {
	updates := make([]api.Update, num)
	for n := 0; n < num; n++ {
		key := model.WorkloadEndpointKey{
			Hostname:       host,
			OrchestratorID: "k8s",
			WorkloadID:     fmt.Sprintf("wep-%d", n),
			EndpointID:     "eth0",
		}
		ipNet := getNextIP()
		updates[n] = api.Update{
			KVPair: model.KVPair{
				Key: key,
				Value: &model.WorkloadEndpoint{
					Labels:     generateLabels(),
					IPv4Nets:   []calinet.IPNet{ipNet},
					ProfileIDs: []string{fmt.Sprintf(conversion.NamespaceProfileNamePrefix+"namespace-%d", n%numNamespaces)},
				},
			},
		}
	}
	return updates
}

var nextIP uint32 = 0xa000001

func getNextIP() calinet.IPNet {
	theIP := net.IPv4(0, 0, 0, 0)
	binary.BigEndian.PutUint32(theIP, nextIP)
	nextIP++
	return calinet.IPNet{IPNet: net.IPNet{
		IP:   theIP,
		Mask: net.CIDRMask(32, 32),
	}}
}

var markerLabels = []string{
	"FOO_BAR",
	"FOO_BAR",
	"BIFF_BOP",
	"calico/FizzBuzz",
	"calico/BoffBip",
	"calico/Bazzle",
	"calico/Razzle",
	"calico/DoopDeeDoo",
	"calico/SOME_LABEL",
	"calico/BORED_NOW",
	"MyMarkerLabel",
	"xFOO_BAR",
	"xBIFF_BOP",
	"xcalico/FizzBuzz",
	"xcalico/BoffBip",
	"xcalico/Bazzle",
	"xcalico/Razzle",
	"xcalico/DoopDeeDoo",
	"xcalico/SOME_LABEL",
	"xcalico/BORED_NOW",
	"yxMyMarkerLabel",
	"yxFOO_BAR",
	"yxBIFF_BOP",
	"yxcalico/FizzBuzz",
	"yxcalico/BoffBip",
	"yxcalico/Bazzle",
	"yxcalico/Razzle",
	"yxcalico/DoopDeeDoo",
	"yxcalico/SOME_LABEL",
	"yxcalico/BORED_NOW",
	"yxMyMarkerLabel",
}

var labelSeed int

func generateLabels() uniquelabels.Map {
	labelSeed++
	labels := map[string]string{}
	for _, n := range []int{10, 11, 20, 30, 40} {
		labels[fmt.Sprintf("one-in-%d", n)] = fmt.Sprintf("value-%d", labelSeed%n)
	}
	labels[markerLabels[(labelSeed)%len(markerLabels)]] = "true"

	// Round trip through JSON; this makes every string unique, simulating
	// what happens when we decode strings for real in felix.
	buf, err := json.Marshal(labels)
	if err != nil {
		panic(err)
	}
	labels = nil
	err = json.Unmarshal(buf, &labels)
	if err != nil {
		panic(err)
	}

	return uniquelabels.Make(labels)
}
