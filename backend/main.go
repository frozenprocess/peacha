package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net"
	"time"

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
	// Don't need this
	conf.UsageReportingEnabled = false
	conf.FelixHostname = "localhost"
	es := calc.NewEventSequencer(conf)
	lookupsCache := calc.NewLookupsCache()
	cg := calc.NewCalculationGraph(es, lookupsCache, conf, func() {
		fmt.Println("Calculation graph updated")
	})
	epUpdates := makeEndpointUpdates(2, "localhost")
	sendEndpointUpdates(cg, epUpdates)
	TiUpdates := makeTierUpdates(1, "default")
	sendEndpointUpdates(cg, TiUpdates)
	polUpdates := makeTagPolicies(10)
	sendEndpointUpdates(cg, polUpdates)
	// rulescanner to match labels
	// if that is successfull then policy matcher should be called
	// We can not read the cg directly so we use the cache
	// here I flag the cg to be in sync which will trigger an offload to cache
	cg.AllUpdDispatcher.OnDatamodelStatus(api.InSync)
	// no idea what we are flushing but it seems to be important
	cg.Flush()
	// Now I can see dead people!
	// selEp := &model.WorkloadEndpointKey{Hostname: "localhost", OrchestratorID: "k8s", WorkloadID: "wep-0", EndpointID: "eth0"}
	ed := lookupsCache.GetAllEndpointData()
	// ed := lookupsCache.GetEndpoint()
	for _, i := range ed {
		fmt.Println(i.EgressMatchData().PolicyMatches)
	}
	// rs := calc.NewRuleScanner()
	// rs.OnPolicyActive()
	time.Sleep(10 * time.Second)

	fmt.Println(ed)
	fmt.Println(cg)
}

func sendEndpointUpdates(cg *calc.CalcGraph, epUpdates []api.Update) {
	cg.AllUpdDispatcher.OnUpdates(epUpdates)
}

var nextTagPolID int

func makeTagPolicies(num int) []api.Update {
	const rulesPerPol = 5
	updates := make([]api.Update, 0, num)
	for i := 0; i < num; i++ {
		pol := &model.Policy{Namespace: "default"}
		pol.Selector = fmt.Sprintf("has(%s)", markerLabels[i%len(markerLabels)])
		pol.Selector = "all()"
		for j := 0; j < rulesPerPol; j++ {
			pol.InboundRules = append(pol.InboundRules, model.Rule{
				Action:      "Deny",
				SrcSelector: fmt.Sprintf("has(%s)", markerLabels[(nextTagPolID+j)%len(markerLabels)]),
			})
		}

		updates = append(updates, api.Update{
			KVPair: model.KVPair{
				Key:   model.PolicyKey{Name: fmt.Sprintf("default/default.tag-pol-%d", nextTagPolID), Tier: "default"},
				Value: pol,
			},
		})

		nextTagPolID++
	}
	return updates
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
			WorkloadID:     fmt.Sprintf("cali-%d", n),
			EndpointID:     "eth0",
		}
		ipNet := getNextIP()
		updates[n] = api.Update{
			KVPair: model.KVPair{
				Key: key,
				Value: &model.WorkloadEndpoint{
					State:      "active",
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
